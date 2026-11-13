import type {
  CreateMarketCreativeBriefRequest,
  MarketCreativeBrief,
  MarketCreativeSeed,
  MarketPlatformStatus,
  MarketProductionFoundationCandidate,
  MarketProductionFoundationSyncState,
  MarketRadarPlatform,
  MarketRadarAnalysisListSelection,
  MarketRankingItem,
  MarketScanRun,
  MarketTrendReport,
} from "@ai-novel/shared/types/marketRadar";
import {
  canStartMarketRadarAnalysis,
  MARKET_RADAR_ANALYSIS_STARTABLE_STATUSES,
  MARKET_RADAR_PLATFORMS,
} from "@ai-novel/shared/types/marketRadar";
import type {
  NovelCreateResourceRecommendation,
  NovelResourceRecommendationOption,
} from "@ai-novel/shared/types/novelResourceRecommendation";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { prisma } from "../../../db/prisma";
import { runStructuredPrompt } from "../../../prompting/core/promptRunner";
import {
  marketCreativeBriefPrompt,
  marketPlatformDigestPrompt,
  marketTrendSynthesisPrompt,
} from "../../../prompting/prompts/marketRadar/marketRadar.prompts";
import type { MarketProductionFoundationDraft } from "../../../prompting/prompts/marketRadar/marketRadar.promptSchemas";
import { ensureSystemResourceStarterData } from "../../../services/bootstrap/SystemResourceBootstrapService";
import { GenreService, type GenreTreeNode } from "../../../services/genre/GenreService";
import { novelCreateResourceRecommendationService } from "../../../services/novel/NovelCreateResourceRecommendationService";
import { StoryModeService, type StoryModeTreeNode } from "../../../services/storyMode/StoryModeService";
import {
  collectMarketSource,
  hasPrivateUseCharacters,
  MARKET_RADAR_SOURCES,
} from "../infrastructure/marketRadarSources";

const REFRESH_GUARD_MS = 30 * 60 * 1000;
const FRESH_REPORT_MS = 24 * 60 * 60 * 1000;
/**
 * 单次 LLM 调用（平台摘要 / 跨平台综合 / 开书简报）的硬超时。
 * 之前这里不传 timeoutMs，模型服务不返回时请求会无限挂起，任务永远停在 75%。
 */
const MARKET_RADAR_LLM_TIMEOUT_MS = (() => {
  const raw = Number(process.env.NWW_MARKET_RADAR_LLM_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 15_000 ? Math.floor(raw) : 100_000;
})();
/** 思考型模型（hy4std 等）会先花掉大量输出额度做推理；额度给太低就会“想完没地方写”，返回空内容。 */
const MARKET_RADAR_DIGEST_MAX_TOKENS = 8_192;
const MARKET_RADAR_SYNTHESIS_MAX_TOKENS = 8_192;
/**
 * 市场雷达固定使用的模型：必须是直出型（不思考）模型。
 * hy4std 这类思考型模型跑 45 条榜单要 90~100 秒、且 8192 额度会被思考吃光，最终拿到截断的 JSON。
 * deepseek-v4.1-flash 同一条 prompt 约 10 秒直出完整 JSON。可用环境变量改回。
 */
const MARKET_RADAR_LLM_PROVIDER = (process.env.NWW_MARKET_RADAR_LLM_PROVIDER?.trim() || "custom_workbuddy") as LLMProvider;
const MARKET_RADAR_LLM_MODEL = process.env.NWW_MARKET_RADAR_LLM_MODEL?.trim() || "deepseek-v4.1-flash";
/** 超过这个时间、且不属于当前进程在跑的任务，视为进程重启后遗留的僵尸任务。 */
const MARKET_RADAR_STALE_GRACE_MS = 30_000;
/** 僵尸任务回收的最小间隔，避免每次轮询都写库。 */
const MARKET_RADAR_RECLAIM_THROTTLE_MS = 10_000;

interface MarketFoundationCatalogOption {
  id: string;
  name: string;
  path: string;
  description?: string | null;
  template?: string | null;
}

interface MarketStoryModeCatalogOption extends MarketFoundationCatalogOption {
  profile: StoryModeTreeNode["profile"];
}

interface StoredMarketBriefSelection {
  signals: MarketTrendReport["signals"];
  creativeSeed?: MarketCreativeSeed | null;
  productionFoundation?: NovelCreateResourceRecommendation | null;
}

export type PlatformDigestGap = { platform: string; message: string };

interface StoredMarketReportData {
  signals: MarketTrendReport["signals"];
  productionFoundationDraft?: MarketProductionFoundationDraft | null;
  productionFoundationSync?: MarketProductionFoundationSyncState | null;
  /** Compatibility for reports produced by the short-lived automatic-sync implementation. */
  productionFoundation?: NovelCreateResourceRecommendation | null;
  analyzedLists?: MarketRadarAnalysisListSelection[];
  analyzedItemIds?: string[];
  /** Platforms whose per-platform digest failed while the rest of the report succeeded. */
  platformDigestGaps?: PlatformDigestGap[];
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function platformLabel(platform: MarketRadarPlatform): string {
  return MARKET_RADAR_SOURCES.find((source) => source.platform === platform)?.platformLabel ?? platform;
}

function normalizePlatforms(platforms?: MarketRadarPlatform[]): MarketRadarPlatform[] {
  const requested = platforms?.filter((platform, index, list) => (
    MARKET_RADAR_PLATFORMS.includes(platform) && list.indexOf(platform) === index
  ));
  return requested?.length ? requested : [...MARKET_RADAR_PLATFORMS];
}

function samePlatforms(left: string, right: MarketRadarPlatform[]): boolean {
  const saved = parseJson<MarketRadarPlatform[]>(left, []).sort();
  return JSON.stringify(saved) === JSON.stringify([...right].sort());
}

function toRankingItem(row: {
  id: string;
  rank: number;
  title: string;
  author: string | null;
  category: string | null;
  tagsJson: string | null;
  synopsis: string | null;
  heatLabel: string | null;
  serialStatus: string | null;
  sourceUrl: string;
  snapshot: { platform: string; listKey: string };
}): MarketRankingItem {
  return {
    id: row.id,
    platform: row.snapshot.platform as MarketRadarPlatform,
    listKey: row.snapshot.listKey,
    rank: row.rank,
    title: row.title,
    author: row.author,
    category: row.category,
    tags: parseJson<string[]>(row.tagsJson, []),
    synopsis: row.synopsis,
    heatLabel: row.heatLabel,
    serialStatus: row.serialStatus,
    sourceUrl: row.sourceUrl,
  };
}

function buildPlatformStatuses(snapshots: Array<{
  platform: string;
  status: string;
  error: string | null;
  capturedAt: Date;
  items: unknown[];
}>): MarketPlatformStatus[] {
  const availablePlatforms = MARKET_RADAR_PLATFORMS.filter((platform) => snapshots.some((snapshot) => snapshot.platform === platform));
  return availablePlatforms.map((platform) => {
    const rows = snapshots.filter((snapshot) => snapshot.platform === platform);
    const succeeded = rows.filter((row) => row.status === "succeeded");
    const failed = rows.filter((row) => row.status === "failed");
    const capturedAt = succeeded.map((row) => row.capturedAt).sort((a, b) => b.getTime() - a.getTime())[0];
    return {
      platform,
      status: succeeded.length > 0 ? failed.length > 0 ? "stale" : "succeeded" : "failed",
      itemCount: succeeded.reduce((sum, row) => sum + row.items.length, 0),
      capturedAt: capturedAt?.toISOString() ?? null,
      error: failed.map((row) => row.error).filter(Boolean).join("；") || null,
    };
  });
}

function formatRankingItems(items: MarketRankingItem[]): string {
  const groups = new Map<string, MarketRankingItem[]>();
  for (const item of items) {
    const key = `${item.title}::${item.author ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const isPrimary = (appearances: MarketRankingItem[]) => appearances.some((item) => item.listKey === "new_book" || item.listKey === "new_author");
  return [...groups.values()].sort((left, right) => Number(isPrimary(right)) - Number(isPrimary(left))).map((appearances) => {
    const item = appearances.sort((left, right) => left.rank - right.rank)[0];
    return [
    `证据层级=${isPrimary(appearances) ? "主要（新书榜或新晋作者榜）" : "辅助（成熟榜单，仅用于验证持续需求）"}`,
    `上榜记录=${appearances.map((appearance) => `${appearance.listKey}第${appearance.rank}名`).join("、")}`,
    `书名=${item.title}`,
    item.author ? `作者=${item.author}` : "",
    item.category ? `分类=${item.category}` : "",
    item.tags.length ? `公开标签=${item.tags.join("、")}` : "",
    item.heatLabel ? `公开热度=${item.heatLabel}` : "",
    item.serialStatus ? `状态=${item.serialStatus}` : "",
    item.synopsis ? `公开简介=${item.synopsis.slice(0, 320)}` : "",
    ].filter(Boolean).join(" | ");
  }).join("\n");
}

function marketSourceKey(value: { platform: string; listKey: string }): string {
  return `${value.platform}:${value.listKey}`;
}

function normalizeAssetName(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}

function flattenGenreCatalog(nodes: GenreTreeNode[], path: string[] = []): MarketFoundationCatalogOption[] {
  return nodes.flatMap((node) => {
    const nextPath = [...path, node.name];
    return [{
      id: node.id,
      name: node.name,
      path: nextPath.join(" / "),
      description: node.description,
      template: node.template,
    }, ...flattenGenreCatalog(node.children, nextPath)];
  });
}

function flattenStoryModeCatalog(nodes: StoryModeTreeNode[], path: string[] = []): MarketStoryModeCatalogOption[] {
  return nodes.flatMap((node) => {
    const nextPath = [...path, node.name];
    return [{
      id: node.id,
      name: node.name,
      path: nextPath.join(" / "),
      description: node.description,
      template: node.template,
      profile: node.profile,
    }, ...flattenStoryModeCatalog(node.children, nextPath)];
  });
}

function formatFoundationCatalog(options: MarketFoundationCatalogOption[]): string {
  return options.map((option) => [
    `ID=${option.id}`,
    `路径=${option.path}`,
    option.description ? `说明=${option.description}` : "",
  ].filter(Boolean).join(" | ")).join("\n");
}

function formatStoryModeCatalog(options: MarketStoryModeCatalogOption[]): string {
  return options.map((option) => [
    `ID=${option.id}`,
    `路径=${option.path}`,
    option.description ? `说明=${option.description}` : "",
    `核心驱动=${option.profile.coreDrive}`,
    `读者奖励=${option.profile.readerReward}`,
  ].filter(Boolean).join(" | ")).join("\n");
}

export function findMarketFoundationAsset<T extends { id: string; name: string }>(
  options: T[],
  draft: { existingId: string | null; name: string },
): T | null {
  if (draft.existingId) {
    return options.find((option) => option.id === draft.existingId) ?? null;
  }
  const nameKey = normalizeAssetName(draft.name);
  return options.find((option) => normalizeAssetName(option.name) === nameKey) ?? null;
}

export function parseStoredMarketBriefSelection(value: string): StoredMarketBriefSelection {
  const parsed = parseJson<MarketTrendReport["signals"] | StoredMarketBriefSelection>(value, []);
  return Array.isArray(parsed)
    ? { signals: parsed }
    : {
      signals: Array.isArray(parsed.signals) ? parsed.signals : [],
      creativeSeed: parsed.creativeSeed ?? null,
      productionFoundation: parsed.productionFoundation ?? null,
    };
}

export function buildMarketBriefRuntimePromptBlock(
  promptBlock: string,
  creativeSeed: MarketCreativeSeed,
  selectedSignals: MarketTrendReport["signals"],
): string {
  return [
    promptBlock.trim(),
    "【用户确认的市场信号】",
    ...selectedSignals.map((signal) => `- ${signal.kind}｜${signal.label}：${signal.summary}`),
    "【开书创意种子】",
    `起始想法：${creativeSeed.openingIdea}`,
    `金手指 / 核心优势：${creativeSeed.coreAdvantage}`,
    `核心卖点：${creativeSeed.bookSellingPoint}`,
    `前30章承诺：${creativeSeed.first30ChapterPromise}`,
  ].join("\n");
}

function markMarketRecommended(
  recommendation: NovelCreateResourceRecommendation,
): NovelCreateResourceRecommendation {
  const markOption = (option: NovelResourceRecommendationOption): NovelResourceRecommendationOption => ({
    ...option,
    source: "market_recommended",
  });
  return {
    ...recommendation,
    genre: markOption(recommendation.genre),
    primaryStoryMode: markOption(recommendation.primaryStoryMode),
    secondaryStoryMode: recommendation.secondaryStoryMode
      ? markOption(recommendation.secondaryStoryMode)
      : null,
  };
}

export function toMarketFoundationCandidate(data: Pick<StoredMarketReportData, "productionFoundationDraft" | "productionFoundation">): MarketProductionFoundationCandidate | null {
  const draft = data.productionFoundationDraft;
  if (draft) {
    const toCandidate = (asset: MarketProductionFoundationDraft["genre"]) => ({
      existingId: asset.existingId,
      name: asset.name,
      reason: asset.reason,
    });
    return {
      genre: toCandidate(draft.genre),
      primaryStoryMode: toCandidate(draft.primaryStoryMode),
      secondaryStoryMode: draft.secondaryStoryMode ? toCandidate(draft.secondaryStoryMode) : null,
    };
  }
  const legacy = data.productionFoundation;
  return legacy ? {
    genre: { existingId: legacy.genre.id, name: legacy.genre.name, reason: legacy.genre.reason },
    primaryStoryMode: {
      existingId: legacy.primaryStoryMode.id,
      name: legacy.primaryStoryMode.name,
      reason: legacy.primaryStoryMode.reason,
    },
    secondaryStoryMode: legacy.secondaryStoryMode ? {
      existingId: legacy.secondaryStoryMode.id,
      name: legacy.secondaryStoryMode.name,
      reason: legacy.secondaryStoryMode.reason,
    } : null,
  } : null;
}

export function selectMarketAnalysisSnapshots<T extends { platform: string; listKey: string }>(
  snapshots: T[],
  selectedLists?: MarketRadarAnalysisListSelection[],
): T[] {
  if (selectedLists?.length) {
    const selectedKeys = new Set(selectedLists.map(marketSourceKey));
    return snapshots.filter((snapshot) => selectedKeys.has(marketSourceKey(snapshot)));
  }
  const newBookPlatforms = new Set(snapshots
    .filter((snapshot) => snapshot.listKey === "new_book" || snapshot.listKey === "new_author")
    .map((snapshot) => snapshot.platform));
  return snapshots.filter((snapshot) => (
    !newBookPlatforms.has(snapshot.platform)
    || snapshot.listKey === "new_book"
    || snapshot.listKey === "new_author"
  ));
}

export function selectMarketAnalysisItems<T extends { id: string }>(items: T[], selectedItemIds?: string[]): T[] {
  if (!selectedItemIds?.length) return items;
  const selectedIds = new Set(selectedItemIds);
  return items.filter((item) => selectedIds.has(item.id));
}

function settledRejectionMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return String(reason);
}

/**
 * 汇总各平台 digest 的 settled 结果：单平台失败只丢该平台，其余平台继续参与后续综合。
 * - fulfilled 的 value 原样保留（含 null：该平台没有可分析 item，不算失败）；
 * - rejected 的位补 null，并记录缺口（message 截断到 300 字符）；
 * - successCount 只统计非 null digest；
 * - platforms/results 长度不一致时按较短者处理，并显式标注长度不一致。
 */
export function summarizePlatformDigestSettledResults<T extends { platform: string }>(
  platforms: readonly string[],
  results: readonly PromiseSettledResult<T | null>[],
): { digests: Array<T | null>; gaps: PlatformDigestGap[]; successCount: number } {
  const lengthMismatch = platforms.length !== results.length;
  const comparableLength = Math.min(platforms.length, results.length);
  const mismatchNotice = `平台与结果数量不一致（platforms=${platforms.length}，results=${results.length}），按较短者处理`;
  const digests: Array<T | null> = [];
  const gaps: PlatformDigestGap[] = [];

  for (let index = 0; index < comparableLength; index += 1) {
    const platform = platforms[index];
    const result = results[index];
    if (result.status === "fulfilled") {
      digests.push(result.value);
      continue;
    }
    digests.push(null);
    const message = `${lengthMismatch ? `${mismatchNotice}；` : ""}${settledRejectionMessage(result.reason)}`;
    gaps.push({ platform, message: message.slice(0, 300) });
  }

  // 防御：长度不一致时补齐说明，避免静默吞掉多余输入。
  if (lengthMismatch && platforms.length > comparableLength) {
    for (let index = comparableLength; index < platforms.length; index += 1) {
      gaps.push({ platform: platforms[index], message: `${mismatchNotice}：缺少该平台的执行结果` });
    }
  } else if (lengthMismatch) {
    gaps.push({ platform: "unknown", message: `${mismatchNotice}：忽略了多余的结果项` });
  }

  const successCount = digests.reduce((count, digest) => (digest ? count + 1 : count), 0);
  return { digests, gaps, successCount };
}

/**
 * 降级报告的信号来源：跨平台综合失败时，直接复用各平台摘要里已经生成的信号，避免报告空掉。
 * 按 kind+label 跨平台去重，id 冲突时补平台前缀保证唯一。
 */
export function collectDegradedSignals(
  digests: ReadonlyArray<{ platform: string; signals: MarketTrendReport["signals"] } | null>,
  limit = 12,
): MarketTrendReport["signals"] {
  const seenLabels = new Set<string>();
  const usedIds = new Set<string>();
  const result: MarketTrendReport["signals"] = [];
  for (const digest of digests) {
    if (!digest) continue;
    for (const signal of digest.signals ?? []) {
      const labelKey = `${signal.kind}:${signal.label}`;
      if (seenLabels.has(labelKey)) continue;
      seenLabels.add(labelKey);
      const id = usedIds.has(signal.id) ? `${digest.platform}-${signal.id}`.slice(0, 48) : signal.id;
      usedIds.add(id);
      result.push({ ...signal, id });
      if (result.length >= limit) return result;
    }
  }
  return result;
}

export class MarketRadarService {
  private readonly genreService = new GenreService();
  private readonly storyModeService = new StoryModeService();

  /** 当前进程里真正在跑的任务；不在这个集合里的 queued/running/analyzing 就是重启遗留的僵尸。 */
  private readonly liveJobs = new Set<string>();

  private lastReclaimAt = 0;

  listSources() {
    return MARKET_RADAR_SOURCES;
  }

  async recoverInterruptedRuns(): Promise<void> {
    await prisma.marketScanRun.updateMany({
      where: { status: { in: ["queued", "running", "analyzing"] } },
      data: { status: "interrupted", lastError: "任务因应用重启而中断，请重新扫榜或分析。", finishedAt: new Date() },
    });
  }

  /**
   * 回收僵尸任务：状态还写着 queued/running/analyzing，但当前进程里已经没有对应的执行体。
   * 场景：ts-node-dev 热重启会把正在等待 LLM 的进程直接杀掉，catch 来不及写状态。
   */
  private async reclaimStaleRuns(): Promise<void> {
    const now = Date.now();
    if (now - this.lastReclaimAt < MARKET_RADAR_RECLAIM_THROTTLE_MS) return;
    this.lastReclaimAt = now;
    await prisma.marketScanRun.updateMany({
      where: {
        status: { in: ["queued", "running", "analyzing"] },
        createdAt: { lt: new Date(now - MARKET_RADAR_STALE_GRACE_MS) },
        ...(this.liveJobs.size > 0 ? { NOT: { id: { in: [...this.liveJobs] } } } : {}),
      },
      data: {
        status: "interrupted",
        lastError: "任务已不在运行（进程重启后遗留），已自动标记中断，请重新扫榜或分析。",
        finishedAt: new Date(),
      },
    }).catch((error) => {
      console.warn("[market-radar] reclaim stale runs failed", error);
    });
  }

  async startScan(platforms?: MarketRadarPlatform[]): Promise<MarketScanRun> {
    await this.reclaimStaleRuns();
    const requestedPlatforms = normalizePlatforms(platforms);
    const recent = await prisma.marketScanRun.findFirst({
      where: { createdAt: { gte: new Date(Date.now() - REFRESH_GUARD_MS) }, status: { in: ["queued", "running", "ready", "analyzing", "succeeded", "partial"] } },
      orderBy: { createdAt: "desc" },
      include: { snapshots: { include: { items: true } } },
    });
    const hasObfuscatedFanqieData = recent?.snapshots.some((snapshot) => snapshot.platform === "fanqie"
      && snapshot.items.some((item) => hasPrivateUseCharacters(item.title) || hasPrivateUseCharacters(item.author)));
    const hasLegacyCompletedProgress = recent && ["ready", "partial", "succeeded"].includes(recent.status) && recent.progress < 1;
    if (recent && samePlatforms(recent.requestedPlatformsJson, requestedPlatforms) && !hasObfuscatedFanqieData && !hasLegacyCompletedProgress) {
      return this.getScan(recent.id) as Promise<MarketScanRun>;
    }

    const run = await prisma.marketScanRun.create({
      data: { requestedPlatformsJson: JSON.stringify(requestedPlatforms) },
    });
    this.liveJobs.add(run.id);
    setImmediate(() => void this.collectRankings(run.id).catch(async (error) => {
      const message = error instanceof Error ? error.message : "扫榜失败";
      console.error("[market-radar] scan failed", error);
      await prisma.marketScanRun.updateMany({
        where: { id: run.id, status: { in: ["queued", "running"] } },
        data: { status: "failed", progress: 1, lastError: message, finishedAt: new Date() },
      });
    }).finally(() => {
      this.liveJobs.delete(run.id);
    }));
    return this.getScan(run.id) as Promise<MarketScanRun>;
  }

  async startAnalysis(
    runId: string,
    input: { selectedLists?: MarketRadarAnalysisListSelection[]; selectedItemIds?: string[] } = {},
  ): Promise<MarketScanRun> {
    await this.reclaimStaleRuns();
    const run = await prisma.marketScanRun.findUnique({
      where: { id: runId },
      include: { snapshots: { include: { items: true } } },
    });
    if (!run) throw new Error("扫榜任务不存在。");
    if (run.status === "queued" || run.status === "running") throw new Error("榜单仍在采集中，请稍后再分析。");
    if (run.status === "analyzing") return this.getScan(runId) as Promise<MarketScanRun>;
    if (!canStartMarketRadarAnalysis(run.status as MarketScanRun["status"])) throw new Error("当前扫榜任务无法启动AI分析，请重新扫榜。");
    const successful = run.snapshots.filter((snapshot) => snapshot.status === "succeeded" && snapshot.items.length > 0);
    if (successful.length === 0) throw new Error("没有可供AI分析的榜单数据。");
    const requestedItemIds = [...new Set(input.selectedItemIds ?? [])];
    const availableItemIds = new Set(successful.flatMap((snapshot) => snapshot.items.map((item) => item.id)));
    if (requestedItemIds.some((id) => !availableItemIds.has(id))) throw new Error("选择中包含不属于本次榜单的作品，请重新选择。");
    const requestedSelections = requestedItemIds.length > 0
      ? successful.filter((snapshot) => snapshot.items.some((item) => requestedItemIds.includes(item.id))).map((snapshot) => ({
        platform: snapshot.platform as MarketRadarPlatform,
        listKey: snapshot.listKey,
      }))
      : input.selectedLists?.length
        ? input.selectedLists
        : selectMarketAnalysisSnapshots(successful).map((snapshot) => ({
          platform: snapshot.platform as MarketRadarPlatform,
          listKey: snapshot.listKey,
        }));
    const uniqueSelections = [...new Map(requestedSelections.map((selection) => [marketSourceKey(selection), selection])).values()];
    const selectedSnapshots = selectMarketAnalysisSnapshots(successful, uniqueSelections);
    if (selectedSnapshots.length !== uniqueSelections.length) throw new Error("选择中包含未成功获取的榜单，请重新选择。");

    const claimed = await prisma.marketScanRun.updateMany({
      where: { id: runId, status: { in: [...MARKET_RADAR_ANALYSIS_STARTABLE_STATUSES] } },
      data: { status: "analyzing", progress: 0.05, lastError: null, finishedAt: null },
    });
    if (claimed.count > 0) {
      this.liveJobs.add(runId);
      setImmediate(() => void this.analyzeRankings(runId, uniqueSelections, requestedItemIds).catch(async (error) => {
        await prisma.marketScanRun.update({
          where: { id: runId },
          data: {
            status: "failed",
            progress: 1,
            lastError: error instanceof Error ? `AI分析失败：${error.message}` : "AI分析失败，请重试。",
            finishedAt: new Date(),
          },
        });
      }).finally(() => {
        this.liveJobs.delete(runId);
      }));
    }
    return this.getScan(runId) as Promise<MarketScanRun>;
  }

  async getLatest(): Promise<MarketTrendReport | null> {
    const report = await prisma.marketTrendReport.findFirst({
      orderBy: { createdAt: "desc" },
      include: { run: { include: { snapshots: { include: { items: true } } } } },
    });
    return report ? this.serializeReport(report) : null;
  }

  async getLatestDisplayableScan(): Promise<MarketScanRun | null> {
    const run = await prisma.marketScanRun.findFirst({
      where: { snapshots: { some: { items: { some: {} } } } },
      orderBy: { createdAt: "desc" },
    });
    return run ? this.getScan(run.id) : null;
  }

  async getScan(id: string): Promise<MarketScanRun | null> {
    await this.reclaimStaleRuns();
    const run = await prisma.marketScanRun.findUnique({
      where: { id },
      include: {
        snapshots: { include: { items: true } },
        reports: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 },
      },
    });
    if (!run) return null;
    const latestReport = run.reports[0];
    const report = latestReport ? await this.getReport(latestReport.id) : null;
    return {
      id: run.id,
      status: run.status as MarketScanRun["status"],
      progress: run.progress,
      requestedPlatforms: parseJson<MarketRadarPlatform[]>(run.requestedPlatformsJson, []),
      platformStatuses: buildPlatformStatuses(run.snapshots),
      rankingItems: run.snapshots.flatMap((snapshot) => snapshot.items.map((item) => toRankingItem({ ...item, snapshot }))),
      report,
      lastError: run.lastError,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
    };
  }

  async getReport(id: string): Promise<MarketTrendReport | null> {
    const report = await prisma.marketTrendReport.findUnique({
      where: { id },
      include: { run: { include: { snapshots: { include: { items: true } } } } },
    });
    return report ? this.serializeReport(report) : null;
  }

  async createBrief(input: CreateMarketCreativeBriefRequest): Promise<MarketCreativeBrief> {
    const report = await this.getReport(input.reportId);
    if (!report) throw new Error("市场分析报告不存在。");
    const uniqueIds = [...new Set(input.signalIds)];
    if (uniqueIds.length < 1 || uniqueIds.length > 5) throw new Error("请选择1至5项市场信号。");
    const selectedSignals = uniqueIds.map((id) => report.signals.find((signal) => signal.id === id)).filter(Boolean) as MarketTrendReport["signals"];
    if (selectedSignals.length !== uniqueIds.length) throw new Error("选择中包含不属于当前报告的市场信号。");
    const result = await runStructuredPrompt({
      asset: marketCreativeBriefPrompt,
      promptInput: {
        influenceMode: input.influenceMode,
        selectedSignalsText: selectedSignals.map((signal) => `${signal.kind}｜${signal.label}｜${signal.summary}`).join("\n"),
      },
      options: { provider: MARKET_RADAR_LLM_PROVIDER, model: MARKET_RADAR_LLM_MODEL, temperature: 0.25, maxTokens: 2_800, stage: "market_radar", itemKey: "creative_brief", entrypoint: "market_radar", timeoutMs: MARKET_RADAR_LLM_TIMEOUT_MS },
    });
    const runtimePromptBlock = buildMarketBriefRuntimePromptBlock(
      result.output.promptBlock,
      result.output.creativeSeed,
      selectedSignals,
    );
    const foundation = await novelCreateResourceRecommendationService.resolveRequired({
      marketBriefPrompt: runtimePromptBlock,
      genreId: report.productionFoundationSync?.genre?.id,
      primaryStoryModeId: report.productionFoundationSync?.storyModes?.primaryStoryMode.id,
      secondaryStoryModeId: report.productionFoundationSync?.storyModes?.secondaryStoryMode?.id,
      description: result.output.creativeSeed.openingIdea,
      bookSellingPoint: result.output.creativeSeed.bookSellingPoint,
      first30ChapterPromise: result.output.creativeSeed.first30ChapterPromise,
      // 这一步内部还会再调一次 LLM 推荐题材基底/推进模式；不指定就会落到全局路由的思考型模型，
      // 之前正是它在 181 秒后返回空内容，导致整个“用这些信号创作”失败。
      provider: MARKET_RADAR_LLM_PROVIDER,
      model: MARKET_RADAR_LLM_MODEL,
      timeoutMs: MARKET_RADAR_LLM_TIMEOUT_MS,
    });
    const productionFoundation = markMarketRecommended(foundation.recommendation);
    const row = await prisma.marketCreativeBrief.create({
      data: {
        reportId: report.id,
        influenceMode: input.influenceMode,
        selectedSignalsJson: JSON.stringify({
          signals: selectedSignals,
          creativeSeed: result.output.creativeSeed,
          productionFoundation,
        }),
        summary: result.output.summary,
        promptBlock: runtimePromptBlock,
      },
    });
    return this.serializeBrief(row);
  }

  async getBrief(id: string): Promise<MarketCreativeBrief | null> {
    const row = await prisma.marketCreativeBrief.findUnique({ where: { id } });
    return row ? this.serializeBrief(row) : null;
  }

  async getBriefPromptBlock(id?: string | null): Promise<string> {
    if (!id?.trim()) return "";
    const brief = await prisma.marketCreativeBrief.findUnique({ where: { id: id.trim() }, select: { promptBlock: true } });
    return brief?.promptBlock.trim() ?? "";
  }

  async listSavedTopics() {
    const rows = await prisma.marketSavedTopic.findMany({ orderBy: { createdAt: "desc" } });
    return rows.map((row) => ({ id: row.id, reportId: row.reportId, signalId: row.signalId, kind: row.kind as MarketTrendReport["signals"][number]["kind"], label: row.label || row.name || "未命名题材", summary: row.summary || row.reason || "", direction: row.direction as MarketTrendReport["signals"][number]["direction"], heat: row.heat, crowding: row.crowding, createdAt: row.createdAt.toISOString() }));
  }

  async saveTopic(input: { reportId: string; signalId: string }) {
    const report = await prisma.marketTrendReport.findUnique({ where: { id: input.reportId } });
    if (!report) throw new Error("市场分析报告不存在。");
    const stored = parseJson<StoredMarketReportData>(report.structuredDataJson, { signals: [] });
    const signal = stored.signals.find((item) => item.id === input.signalId);
    if (!signal) throw new Error("这条市场信号不属于当前报告。");
    const row = await prisma.marketSavedTopic.upsert({
      where: { reportId_signalId: { reportId: report.id, signalId: signal.id } },
      create: { reportId: report.id, signalId: signal.id, kind: signal.kind, label: signal.label, summary: signal.summary, direction: signal.direction, heat: signal.heat, crowding: signal.crowding },
      update: { kind: signal.kind, label: signal.label, summary: signal.summary, direction: signal.direction, heat: signal.heat, crowding: signal.crowding },
    });
    return { id: row.id, reportId: row.reportId, signalId: row.signalId, kind: row.kind as MarketTrendReport["signals"][number]["kind"], label: row.label, summary: row.summary, direction: row.direction as MarketTrendReport["signals"][number]["direction"], heat: row.heat, crowding: row.crowding, createdAt: row.createdAt.toISOString() };
  }

  async deleteSavedTopic(id: string): Promise<void> {
    await prisma.marketSavedTopic.delete({ where: { id } });
  }

  private async collectRankings(runId: string): Promise<void> {
    const run = await prisma.marketScanRun.update({
      where: { id: runId },
      data: { status: "running", startedAt: new Date(), progress: 0.05, lastError: null },
    });
    const requested = parseJson<MarketRadarPlatform[]>(run.requestedPlatformsJson, []);
    const sources = MARKET_RADAR_SOURCES.filter((source) => requested.includes(source.platform));
    await Promise.all(sources.map(async (source) => {
      try {
        const items = await collectMarketSource(source);
        await prisma.marketRankingSnapshot.create({
          data: {
            runId, platform: source.platform, listKey: source.listKey, listLabel: source.listLabel,
            channel: source.channel, sourceUrl: source.sourceUrl,
            items: { create: items.map((item) => ({
              rank: item.rank,
              title: item.title,
              author: item.author,
              category: item.category,
              tagsJson: JSON.stringify(item.tags),
              synopsis: item.synopsis,
              heatLabel: item.heatLabel,
              serialStatus: item.serialStatus,
              sourceUrl: item.sourceUrl,
            })) },
          },
        });
      } catch (error) {
        await prisma.marketRankingSnapshot.create({
          data: {
            runId, platform: source.platform, listKey: source.listKey, listLabel: source.listLabel,
            channel: source.channel, sourceUrl: source.sourceUrl, status: "failed",
            error: error instanceof Error ? error.message : "榜单采集失败",
          },
        });
      } finally {
        await prisma.marketScanRun.update({ where: { id: runId }, data: { progress: { increment: 0.9 / sources.length } } });
      }
    }));

    const snapshots = await prisma.marketRankingSnapshot.findMany({ where: { runId }, include: { items: true } });
    const successful = snapshots.filter((snapshot) => snapshot.status === "succeeded" && snapshot.items.length > 0);
    if (successful.length === 0) {
      await prisma.marketScanRun.update({ where: { id: runId }, data: { status: "failed", progress: 1, finishedAt: new Date(), lastError: "三个平台均未获取到可分析的公开榜单元数据。" } });
      return;
    }

    const hasFailures = snapshots.some((snapshot) => snapshot.status === "failed");
    await prisma.marketScanRun.update({
      where: { id: runId },
      data: { status: hasFailures ? "partial" : "ready", progress: 1, finishedAt: new Date() },
    });
  }

  private async analyzeRankings(
    runId: string,
    selectedLists: MarketRadarAnalysisListSelection[],
    selectedItemIds?: string[],
  ): Promise<void> {
    const snapshots = await prisma.marketRankingSnapshot.findMany({ where: { runId }, include: { items: true } });
    const successful = snapshots.filter((snapshot) => snapshot.status === "succeeded" && snapshot.items.length > 0);
    const analysisSnapshots = selectMarketAnalysisSnapshots(successful, selectedLists)
      .map((snapshot) => ({ ...snapshot, items: selectMarketAnalysisItems(snapshot.items, selectedItemIds) }))
      .filter((snapshot) => snapshot.items.length > 0);
    const requested = [...new Set(snapshots.map((snapshot) => snapshot.platform as MarketRadarPlatform))];
    const allRows = analysisSnapshots.flatMap((snapshot) => snapshot.items.map((item) => ({ ...item, snapshot })));
    const allItems = allRows.map(toRankingItem);
    const tolerant = process.env.NWW_MARKET_DIGEST_TOLERANT !== "0";
    const settled = await Promise.allSettled(requested.map(async (platform) => {
      const items = allItems.filter((item) => item.platform === platform);
      if (items.length === 0) return null;
      let lastError: unknown;
      // 本地 LLM 端点偶发空响应（empty_response → transport_error），瞬时抖动通过重试自愈，避免无谓降级为 partial。
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const result = await runStructuredPrompt({
            asset: marketPlatformDigestPrompt,
            promptInput: { platformLabel: platformLabel(platform), rankingText: formatRankingItems(items) },
            options: { provider: MARKET_RADAR_LLM_PROVIDER, model: MARKET_RADAR_LLM_MODEL, temperature: 0.2, maxTokens: MARKET_RADAR_DIGEST_MAX_TOKENS, taskId: runId, stage: "market_radar", itemKey: `digest_${platform}`, entrypoint: "market_radar", timeoutMs: MARKET_RADAR_LLM_TIMEOUT_MS },
          });
          return { platform, ...result.output };
        } catch (error) {
          lastError = error;
          if (attempt < 2) continue;
        }
      }
      throw lastError instanceof Error ? lastError : new Error("平台摘要生成失败");
    }));
    const summarized = summarizePlatformDigestSettledResults(requested, settled);
    if (!tolerant && summarized.gaps.length > 0) {
      throw new Error(`平台摘要生成失败：${summarized.gaps.map((gap) => gap.platform).join("、")}（NWW_MARKET_DIGEST_TOLERANT=0 回滚模式）`);
    }
    if (summarized.successCount === 0 && summarized.gaps.length > 0) {
      throw new Error(`所有平台摘要均生成失败：${summarized.gaps.map((gap) => gap.platform).join("、")}`);
    }
    const platformDigests = summarized.digests;
    await prisma.marketScanRun.update({ where: { id: runId }, data: { progress: 0.75 } });

    await ensureSystemResourceStarterData();
    const [genreTree, storyModeTree, history] = await Promise.all([
      this.genreService.listGenreTree(),
      this.storyModeService.listStoryModeTree(),
      this.buildHistorySummary(analysisSnapshots),
    ]);
    const genreCatalog = flattenGenreCatalog(genreTree);
    const storyModeCatalog = flattenStoryModeCatalog(storyModeTree);
    let synthesisOutput: {
      summary: string;
      signals: MarketTrendReport["signals"];
      productionFoundation: MarketProductionFoundationDraft;
    } | null = null;
    let synthesisMeta: { provider?: string | null; model?: string | null } = {};
    let synthesisError: string | null = null;
    try {
      const synthesis = await runStructuredPrompt({
        asset: marketTrendSynthesisPrompt,
        promptInput: {
          platformDigestsText: platformDigests.filter(Boolean).map((digest) => `${platformLabel(digest!.platform)}\n${digest!.platformSummary}\n${JSON.stringify(digest!.signals)}`).join("\n\n"),
          historyText: history.text,
          genreCatalogText: formatFoundationCatalog(genreCatalog),
          storyModeCatalogText: formatStoryModeCatalog(storyModeCatalog),
          allowedGenreIds: genreCatalog.map((item) => item.id),
          allowedStoryModeIds: storyModeCatalog.map((item) => item.id),
          hasComparableHistory: history.hasComparableHistory,
        },
        options: { provider: MARKET_RADAR_LLM_PROVIDER, model: MARKET_RADAR_LLM_MODEL, temperature: 0.2, maxTokens: MARKET_RADAR_SYNTHESIS_MAX_TOKENS, taskId: runId, stage: "market_radar", itemKey: "cross_platform_synthesis", entrypoint: "market_radar", timeoutMs: MARKET_RADAR_LLM_TIMEOUT_MS },
      });
      synthesisOutput = synthesis.output;
      synthesisMeta = { provider: synthesis.meta.provider, model: synthesis.meta.model };
    } catch (error) {
      synthesisError = error instanceof Error ? error.message : "跨平台综合失败";
      console.warn("[market-radar] cross platform synthesis failed, degraded to digest-only report", synthesisError);
    }
    const hasFailures = snapshots.some((snapshot) => snapshot.status === "failed");

    if (synthesisOutput) {
      const { productionFoundation: productionFoundationDraft, ...reportOutput } = synthesisOutput;
      await prisma.marketTrendReport.create({
        data: {
          runId,
          summary: synthesisOutput.summary,
          structuredDataJson: JSON.stringify({
            ...reportOutput,
            productionFoundationDraft,
            productionFoundationSync: {},
            analyzedLists: selectedLists,
            analyzedItemIds: selectedItemIds,
            platformDigestGaps: summarized.gaps,
          }),
        },
      });
      await prisma.marketScanRun.update({
        where: { id: runId },
        data: {
          status: hasFailures || summarized.gaps.length > 0 ? "partial" : "succeeded",
          progress: 1,
          provider: synthesisMeta.provider,
          model: synthesisMeta.model,
          finishedAt: new Date(),
          ...(summarized.gaps.length > 0
            ? { lastError: `平台摘要缺口：${summarized.gaps.map((gap) => gap.platform).join("、")}` }
            : {}),
        },
      });
      return;
    }

    // 降级：跨平台综合失败或超时，仍用各平台摘要拼出一份可读报告，避免整条任务作废。
    const degradedSignals = collectDegradedSignals(platformDigests);
    const degradedSummary = `跨平台综合未完成（${synthesisError ?? "原因未知"}）。以下为各平台榜单摘要的合并结果，可直接参考或稍后重新分析。\n${platformDigests
      .filter((digest): digest is NonNullable<typeof digest> => Boolean(digest))
      .map((digest) => `${platformLabel(digest.platform)}：${digest.platformSummary}`)
      .join("\n")}`.slice(0, 500);
    await prisma.marketTrendReport.create({
      data: {
        runId,
        summary: degradedSummary,
        structuredDataJson: JSON.stringify({
          signals: degradedSignals,
          productionFoundationDraft: null,
          productionFoundationSync: {},
          analyzedLists: selectedLists,
          analyzedItemIds: selectedItemIds,
          platformDigestGaps: summarized.gaps,
          degraded: true,
          degradedReason: synthesisError,
        }),
      },
    });
    await prisma.marketScanRun.update({
      where: { id: runId },
      data: {
        status: "partial",
        progress: 1,
        finishedAt: new Date(),
        lastError: `AI 跨平台综合失败，已降级为平台摘要版：${synthesisError ?? "原因未知"}`,
      },
    });
  }

  private async buildHistorySummary(currentSnapshots: Array<{ platform: string; listKey: string; capturedAt: Date; items: Array<{ title: string; author: string | null; rank: number }> }>): Promise<{ text: string; hasComparableHistory: boolean }> {
    const lines: string[] = [];
    for (const current of currentSnapshots) {
      const previous = await prisma.marketRankingSnapshot.findFirst({
        where: { platform: current.platform, listKey: current.listKey, status: "succeeded", capturedAt: { lt: current.capturedAt } },
        orderBy: { capturedAt: "desc" }, include: { items: true },
      });
      if (!previous) continue;
      const previousRanks = new Map(previous.items.map((item) => [`${item.title}::${item.author ?? ""}`, item.rank]));
      const changes = current.items.flatMap((item) => {
        const oldRank = previousRanks.get(`${item.title}::${item.author ?? ""}`);
        return oldRank ? [`${item.title}: ${oldRank}→${item.rank}`] : [];
      }).slice(0, 20);
      lines.push(`${current.platform}/${current.listKey}: ${changes.join("，") || "没有重复上榜作品"}`);
    }
    return { text: lines.join("\n"), hasComparableHistory: lines.length > 0 };
  }

  private serializeReport(report: {
    id: string; runId: string; summary: string; structuredDataJson: string; createdAt: Date;
    run: { snapshots: Array<{ platform: string; listKey: string; status: string; error: string | null; capturedAt: Date; items: any[] }> };
  }): MarketTrendReport {
    const structured = parseJson<StoredMarketReportData>(report.structuredDataJson, { signals: [] });
    const successfulSnapshots = report.run.snapshots.filter((snapshot) => snapshot.status === "succeeded" && snapshot.items.length > 0);
    const analyzedLists = structured.analyzedLists?.length
      ? structured.analyzedLists
      : selectMarketAnalysisSnapshots(successfulSnapshots).map((snapshot) => ({
        platform: snapshot.platform as MarketRadarPlatform,
        listKey: snapshot.listKey,
      }));
    const platformStatuses = buildPlatformStatuses(report.run.snapshots).map((status) => (
      Date.now() - report.createdAt.getTime() > FRESH_REPORT_MS && status.status === "succeeded"
        ? { ...status, status: "stale" as const }
        : status
    ));
    return {
      id: report.id, scanRunId: report.runId, summary: report.summary, signals: structured.signals,
      analyzedLists, analyzedItemIds: structured.analyzedItemIds,
      productionFoundationCandidate: toMarketFoundationCandidate(structured),
      productionFoundationSync: structured.productionFoundationSync ?? null,
      platformStatuses, createdAt: report.createdAt.toISOString(),
    };
  }

  private serializeBrief(row: { id: string; reportId: string; influenceMode: string; selectedSignalsJson: string; summary: string; promptBlock: string; createdAt: Date }): MarketCreativeBrief {
    const selection = parseStoredMarketBriefSelection(row.selectedSignalsJson);
    return {
      id: row.id, reportId: row.reportId, influenceMode: row.influenceMode as MarketCreativeBrief["influenceMode"],
      selectedSignals: selection.signals, summary: row.summary, promptBlock: row.promptBlock,
      creativeSeed: selection.creativeSeed ?? null,
      productionFoundation: selection.productionFoundation ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

export const marketRadarService = new MarketRadarService();
