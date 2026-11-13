import type {
  VolumeBeat,
  VolumeBeatSheet,
  VolumePlan,
  VolumePlanDocument,
} from "@ai-novel/shared/types/novel";
import type { StoryMacroPlan } from "@ai-novel/shared/types/storyMacro";
import { runStructuredPrompt } from "../../../prompting/core/promptRunner";
import { logMemoryUsage } from "../../../runtime/memoryTelemetry";
import { createVolumeChapterListPrompt } from "../../../prompting/prompts/novel/volume/chapterList.prompts";
import { buildVolumeChapterListContextBlocks } from "../../../prompting/prompts/novel/volume/contextBlocks";
import {
  inferRequiredChapterCountFromBeatSheet,
  resolveTargetChapterCount,
  validateBeatSheetChapterCoverage,
} from "./volumeBeatSheetChapterBudget";
import {
  allocateChapterBudgets,
  deriveChapterBudget,
  resolveEvenShareChapterBudget,
  GeneratedVolumeChapterBlock,
  getBeatExpectedChapterCount,
  getBeatSheet,
  getTargetVolume,
  isVolumeChapterListPartiallyPersisted,
  mergeChapterList,
  resolveVolumeChapterBeatKey,
  setVolumeChapterListPartialStatus,
} from "./volumeGenerationHelpers";
import { assertChapterTitleDiversity } from "./chapterTitleDiversity";
import type {
  VolumeGenerateOptions,
  VolumeGenerationNovel,
  VolumeIntermediateDocumentEvent,
  VolumeWorkspace,
} from "./volumeModels";

type StoryMacroPlanResult = StoryMacroPlan | null;

interface BeatGenerationPlan {
  beat: VolumeBeat;
  chapterCount: number;
  chapterStartOrder: number;
  chapterEndOrder: number;
}

interface FullVolumeResumeState {
  resumeBeatIndex: number;
  resumeBeatKey: string | null;
  preservedBeatBlocks: GeneratedVolumeChapterBlock[];
  isAlreadyComplete: boolean;
}

export function isCompactBookFinaleBeat(params: {
  completionProfile: VolumeGenerationNovel["completionProfile"];
  targetVolumeIndex: number;
  chapterBudgets: number[];
  beatChapterEndOrder: number;
}): boolean {
  if (params.completionProfile?.mode !== "compact_book" || params.targetVolumeIndex < 0) {
    return false;
  }
  const chaptersBeforeCurrentVolume = params.chapterBudgets
    .slice(0, params.targetVolumeIndex)
    .reduce((total, chapterCount) => total + chapterCount, 0);
  return chaptersBeforeCurrentVolume + params.beatChapterEndOrder
    >= params.completionProfile.endingRequiredBy;
}

function buildBeatGenerationPlans(beatSheet: VolumeBeatSheet): BeatGenerationPlan[] {
  let nextChapterOrder = 1;
  return beatSheet.beats.map((beat) => {
    const chapterCount = Math.max(1, getBeatExpectedChapterCount(beat));
    const plan: BeatGenerationPlan = {
      beat,
      chapterCount,
      chapterStartOrder: nextChapterOrder,
      chapterEndOrder: nextChapterOrder + chapterCount - 1,
    };
    nextChapterOrder = plan.chapterEndOrder + 1;
    return plan;
  });
}

function resolveFullVolumeResumeState(params: {
  beatPlans: BeatGenerationPlan[];
  existingBeatBlocks: GeneratedVolumeChapterBlock[];
}): FullVolumeResumeState {
  let resumeBeatIndex = params.beatPlans.length;
  for (const [index, beatPlan] of params.beatPlans.entries()) {
    const existingBlock = params.existingBeatBlocks[index];
    if (existingBlock && existingBlock.chapters.length === beatPlan.chapterCount) {
      continue;
    }
    resumeBeatIndex = index;
    break;
  }

  if (resumeBeatIndex >= params.beatPlans.length) {
    return {
      resumeBeatIndex,
      resumeBeatKey: null,
      preservedBeatBlocks: params.existingBeatBlocks.slice(),
      isAlreadyComplete: true,
    };
  }

  return {
    resumeBeatIndex,
    resumeBeatKey: params.beatPlans[resumeBeatIndex]?.beat.key ?? null,
    preservedBeatBlocks: params.existingBeatBlocks.slice(0, resumeBeatIndex),
    isAlreadyComplete: false,
  };
}

function summarizeBeatBlocks(blocks: GeneratedVolumeChapterBlock[]): string {
  if (blocks.length === 0) {
    return "none";
  }
  return blocks
    .map((block) => (
      `${block.beatLabel} (${block.beatKey}) | ${block.chapterCount}章 | ${
        block.chapters.map((chapter, index) => `第${index + 1}章 ${chapter.title}`).join(" / ")
      }`
    ))
    .join("\n");
}

function buildExistingBeatBlocks(params: {
  volume: VolumePlan;
  beatSheet: VolumeBeatSheet;
}): GeneratedVolumeChapterBlock[] {
  return params.beatSheet.beats.map((beat) => {
    const chapters = params.volume.chapters
      .slice()
      .sort((left, right) => left.chapterOrder - right.chapterOrder)
      .filter((chapter) => resolveVolumeChapterBeatKey({
        chapter,
        volume: params.volume,
        beatSheet: params.beatSheet,
      }) === beat.key)
      .map((chapter) => ({
        beatKey: beat.key,
        title: chapter.title,
        summary: chapter.summary,
        ...(chapter.plannedCharacterIds !== undefined ? {plannedCharacterIds: chapter.plannedCharacterIds} : {}),
      }));

    return {
      beatKey: beat.key,
      beatLabel: beat.label,
      chapterCount: chapters.length,
      chapters,
    };
  });
}

function buildPreviousBeatSummary(params: {
  generationMode: "full_volume" | "single_beat";
  generatedBlocks: GeneratedVolumeChapterBlock[];
  existingBeatBlocks: GeneratedVolumeChapterBlock[];
  preservedBeatBlocks?: GeneratedVolumeChapterBlock[];
  targetBeatIndex: number;
}): string {
  if (params.generationMode === "full_volume") {
    return summarizeBeatBlocks([...(params.preservedBeatBlocks ?? []), ...params.generatedBlocks]);
  }
  return summarizeBeatBlocks(params.existingBeatBlocks.slice(0, params.targetBeatIndex));
}

function buildPreservedBeatSummary(params: {
  existingBeatBlocks: GeneratedVolumeChapterBlock[];
  targetBeatIndex: number;
}): string {
  return summarizeBeatBlocks(params.existingBeatBlocks
    .slice(params.targetBeatIndex + 1)
    .filter((block) => block.chapters.length > 0));
}

function assertMergedVolumeChapterList(params: {
  volume: VolumePlan;
  beatSheet: VolumeBeatSheet;
  generationMode: "full_volume" | "single_beat";
  targetBeatKey?: string | null;
}): void {
  const sortedChapters = params.volume.chapters
    .slice()
    .sort((left, right) => left.chapterOrder - right.chapterOrder);

  for (const beat of params.beatSheet.beats) {
    if (params.generationMode === "single_beat" && beat.key !== params.targetBeatKey) {
      continue;
    }
    const expectedChapterCount = Math.max(1, getBeatExpectedChapterCount(beat));
    const matchedChapters = sortedChapters.filter((chapter) => resolveVolumeChapterBeatKey({
      chapter,
      volume: params.volume,
      beatSheet: params.beatSheet,
    }) === beat.key);
    if (matchedChapters.length !== expectedChapterCount) {
      throw new Error(`当前卷节奏段「${beat.label}」应有 ${expectedChapterCount} 章，实际只有 ${matchedChapters.length} 章。`);
    }
  }
}

function isMergedVolumeChapterListComplete(params: {
  volume: VolumePlan;
  beatSheet: VolumeBeatSheet;
}): boolean {
  const sortedChapters = params.volume.chapters
    .slice()
    .sort((left, right) => left.chapterOrder - right.chapterOrder);

  return params.beatSheet.beats.every((beat) => {
    const expectedChapterCount = Math.max(1, getBeatExpectedChapterCount(beat));
    const matchedChapterCount = sortedChapters.filter((chapter) => resolveVolumeChapterBeatKey({
      chapter,
      volume: params.volume,
      beatSheet: params.beatSheet,
    }) === beat.key).length;
    return matchedChapterCount === expectedChapterCount;
  });
}

const MAX_CHAPTERS_PER_GENERATION_CALL = 12;

interface BeatChapterChunkPlan {
  chapterStartOrder: number;
  chapterEndOrder: number;
  chapterCount: number;
}

function buildBeatChapterChunkPlans(beatPlan: BeatGenerationPlan): BeatChapterChunkPlan[] {
  const total = Math.max(1, beatPlan.chapterCount);
  if (total <= MAX_CHAPTERS_PER_GENERATION_CALL) {
    return [{
      chapterStartOrder: beatPlan.chapterStartOrder,
      chapterEndOrder: beatPlan.chapterEndOrder,
      chapterCount: total,
    }];
  }

  const chunkCount = Math.ceil(total / MAX_CHAPTERS_PER_GENERATION_CALL);
  const baseCount = Math.floor(total / chunkCount);
  const remainder = total % chunkCount;
  let nextStartOrder = beatPlan.chapterStartOrder;

  return Array.from({ length: chunkCount }, (_unused, index) => {
    const chapterCount = baseCount + (index < remainder ? 1 : 0);
    const chunk: BeatChapterChunkPlan = {
      chapterStartOrder: nextStartOrder,
      chapterEndOrder: nextStartOrder + chapterCount - 1,
      chapterCount,
    };
    nextStartOrder = chunk.chapterEndOrder + 1;
    return chunk;
  });
}

async function generateBeatChapterChunk(params: {
  document: VolumePlanDocument;
  workspace: VolumeWorkspace;
  novel: VolumeGenerationNovel;
  storyMacroPlan: StoryMacroPlanResult;
  options: VolumeGenerateOptions;
  targetVolume: VolumePlan;
  targetBeatSheet: VolumeBeatSheet;
  beatPlan: BeatGenerationPlan;
  chunkPlan: BeatChapterChunkPlan;
  chunkIndex: number;
  chunkTotal: number;
  isFinalChunk: boolean;
  reservedChapterTitles: string[];
  previousBeat?: VolumeBeat | null;
  nextBeat?: VolumeBeat | null;
  previousBeatChapterSummary?: string | null;
  preservedBeatChapterSummary?: string | null;
  chapterBudgets: number[];
}): Promise<GeneratedVolumeChapterBlock> {
  const targetIndex = params.document.volumes.findIndex((volume) => volume.id === params.targetVolume.id);
  const promptInput = {
    novel: params.novel,
    workspace: params.workspace,
    storyMacroPlan: params.storyMacroPlan,
    strategyPlan: params.document.strategyPlan,
    targetVolume: params.targetVolume,
    targetBeatSheet: params.targetBeatSheet,
    targetBeat: params.beatPlan.beat,
    previousBeat: params.previousBeat,
    nextBeat: params.nextBeat,
    previousVolume: targetIndex > 0 ? params.document.volumes[targetIndex - 1] : undefined,
    nextVolume: targetIndex >= 0 && targetIndex < params.document.volumes.length - 1
      ? params.document.volumes[targetIndex + 1]
      : undefined,
    guidance: params.options.guidance,
    targetBeatChapterCount: params.chunkPlan.chapterCount,
    targetChapterStartOrder: params.chunkPlan.chapterStartOrder,
    targetChapterEndOrder: params.chunkPlan.chapterEndOrder,
    nextAvailableChapterOrder: params.chunkPlan.chapterStartOrder,
    previousBeatChapterSummary: params.previousBeatChapterSummary,
    preservedBeatChapterSummary: params.preservedBeatChapterSummary,
    beatChunkContext: params.chunkTotal > 1
      ? {
        index: params.chunkIndex,
        total: params.chunkTotal,
        beatChapterCount: params.beatPlan.chapterCount,
        chapterStartOrder: params.chunkPlan.chapterStartOrder,
        chapterEndOrder: params.chunkPlan.chapterEndOrder,
      }
      : null,
  };

  const generated = await runStructuredPrompt({
    asset: createVolumeChapterListPrompt({
      targetChapterCount: params.chunkPlan.chapterCount,
      targetBeatKey: params.beatPlan.beat.key,
      targetBeatLabel: params.beatPlan.beat.label,
      isBookFinale: params.isFinalChunk && isCompactBookFinaleBeat({
        completionProfile: params.novel.completionProfile,
        targetVolumeIndex: targetIndex,
        chapterBudgets: params.chapterBudgets,
        beatChapterEndOrder: params.beatPlan.chapterEndOrder,
      }),
      reservedChapterTitles: params.reservedChapterTitles,
      characterIds: params.options.entrypoint === "director_next" ? params.novel.characters.map(character => {
        if (!character.id) throw new Error("角色出场初排缺少角色 ID。");
        return character.id;
      }) : undefined,
    }),
    promptInput,
    contextBlocks: buildVolumeChapterListContextBlocks(promptInput),
    options: {
      provider: params.options.provider,
      model: params.options.model,
      temperature: params.options.temperature ?? 0.35,
      // 分批后单次最多 12 章；每章含 plannedCharacterIds 时 JSON 约 380 tokens。
      maxTokens: Math.min(params.options.entrypoint === "director_next" ? 12_000 : 8_000,
        900 + params.chunkPlan.chapterCount * (params.options.entrypoint === "director_next" ? 380 : 260)),
      novelId: params.document.novelId,
      volumeId: params.targetVolume.id,
      taskId: params.options.taskId,
      stage: "structured_outline",
      itemKey: "chapter_list",
      scope: "chapter_list",
      entrypoint: params.options.entrypoint,
      signal: params.options.signal,
    },
  });

  return generated.output;
}

async function generateBeatChapterBlock(params: {
  document: VolumePlanDocument;
  workspace: VolumeWorkspace;
  novel: VolumeGenerationNovel;
  storyMacroPlan: StoryMacroPlanResult;
  options: VolumeGenerateOptions;
  targetVolume: VolumePlan;
  targetBeatSheet: VolumeBeatSheet;
  beatPlan: BeatGenerationPlan;
  reservedChapterTitles: string[];
  previousBeat?: VolumeBeat | null;
  nextBeat?: VolumeBeat | null;
  previousBeatChapterSummary?: string | null;
  preservedBeatChapterSummary?: string | null;
  chapterBudgets: number[];
}): Promise<GeneratedVolumeChapterBlock> {
  const chunkPlans = buildBeatChapterChunkPlans(params.beatPlan);

  if (chunkPlans.length === 1) {
    return generateBeatChapterChunk({
      ...params,
      chunkPlan: chunkPlans[0],
      chunkIndex: 1,
      chunkTotal: 1,
      isFinalChunk: true,
    });
  }

  const generatedChunks: GeneratedVolumeChapterBlock[] = [];
  for (const [index, chunkPlan] of chunkPlans.entries()) {
    const reservedChapterTitles = Array.from(new Set([
      ...params.reservedChapterTitles,
      ...generatedChunks.flatMap((block) => block.chapters.map((chapter) => chapter.title)),
    ]));
    const previousChunkSummary = generatedChunks.length > 0
      ? summarizeBeatBlocks(generatedChunks)
      : null;
    const previousBeatChapterSummary = [
      params.previousBeatChapterSummary?.trim() ?? "",
      previousChunkSummary ?? "",
    ].filter(Boolean).join("\n") || null;

    generatedChunks.push(await generateBeatChapterChunk({
      ...params,
      chunkPlan,
      chunkIndex: index + 1,
      chunkTotal: chunkPlans.length,
      isFinalChunk: index === chunkPlans.length - 1,
      reservedChapterTitles,
      previousBeatChapterSummary,
    }));
  }

  const chapterCount = generatedChunks.reduce((sum, block) => sum + block.chapters.length, 0);
  if (chapterCount !== params.beatPlan.chapterCount) {
    throw new Error(
      `节奏段「${params.beatPlan.beat.label}」分批生成后应有 ${params.beatPlan.chapterCount} 章，实际只有 ${chapterCount} 章。`,
    );
  }

  return {
    beatKey: params.beatPlan.beat.key,
    beatLabel: params.beatPlan.beat.label,
    chapterCount,
    chapters: generatedChunks.flatMap((block) => block.chapters),
  };
}

export async function generateBeatChunkedChapterList(params: {
  document: VolumePlanDocument;
  novel: VolumeGenerationNovel;
  workspace: VolumeWorkspace;
  storyMacroPlan: StoryMacroPlanResult;
  options: VolumeGenerateOptions;
  notifyPhase: (label: string) => Promise<void>;
  notifyIntermediateDocument?: (event: VolumeIntermediateDocumentEvent) => void | Promise<void>;
}): Promise<{
  mergedDocument: VolumePlanDocument;
  mergedWorkspace: VolumeWorkspace;
}> {
  const { document, novel, workspace, storyMacroPlan, options } = params;
  const targetVolume = getTargetVolume(document, options.targetVolumeId);
  const targetBeatSheet = getBeatSheet(document, targetVolume.id);
  logMemoryUsage({
    event: "start",
    component: "generateBeatChunkedChapterList",
    taskId: options.taskId,
    novelId: document.novelId,
    stage: "structured_outline",
    itemKey: "chapter_list",
    scope: options.generationMode ?? "full_volume",
    entrypoint: options.entrypoint,
    volumeId: targetVolume.id,
    volumeCount: document.volumes.length,
    chapterCount: document.volumes.reduce((sum, volume) => sum + volume.chapters.length, 0),
    beatSheetCount: document.beatSheets.length,
  });
  if (!targetBeatSheet) {
    throw new Error("当前卷还没有节奏板，不能直接拆章节列表。");
  }

  const chapterBudget = deriveChapterBudget({ novel, workspace, options });
  const chapterBudgets = allocateChapterBudgets({
    volumeCount: Math.max(document.volumes.length, 1),
    chapterBudget,
    existingVolumes: document.volumes,
  });
  const targetIndex = document.volumes.findIndex((volume) => volume.id === targetVolume.id);
  const beatSheetRequiredChapterCount = inferRequiredChapterCountFromBeatSheet(targetBeatSheet);
  // 正在生成的卷当前章数是进度而非计划规模，其预算不得低于均分份额（issue #173）。
  const fallbackTargetChapterCount = Math.max(
    chapterBudgets[targetIndex] ?? 0,
    resolveEvenShareChapterBudget(chapterBudget, document.volumes.length),
  );
  // Legacy or partially generated workspaces may only carry a few seed chapters for the opening beat.
  // Those placeholders should not shrink the trusted chapter budget below the planned volume size.
  const budgetedTargetChapterCount = Math.max(targetVolume.chapters.length, fallbackTargetChapterCount);
  const resolvedTargetChapterCount = resolveTargetChapterCount({
    budgetedChapterCount: budgetedTargetChapterCount,
    beatSheetRequiredChapterCount,
  });
  if (!resolvedTargetChapterCount.beatSheetCountAccepted && beatSheetRequiredChapterCount > 0) {
    throw new Error("当前卷节奏板的章节跨度异常，建议先重生成节奏板，再继续生成章节标题。");
  }
  if (resolvedTargetChapterCount.targetChapterCount >= 20) {
    const beatSheetCoverage = validateBeatSheetChapterCoverage({
      beatSheet: targetBeatSheet,
      targetChapterCount: resolvedTargetChapterCount.targetChapterCount,
    });
    if (!beatSheetCoverage.accepted) {
      throw new Error(`${beatSheetCoverage.message ?? "当前卷节奏板章节跨度没有覆盖目标章数。"}建议先重生成节奏板，再继续生成章节标题。`);
    }
  }

  const generationMode = options.generationMode ?? "full_volume";
  const beatPlans = buildBeatGenerationPlans(targetBeatSheet);
  const existingBeatBlocks = buildExistingBeatBlocks({
    volume: targetVolume,
    beatSheet: targetBeatSheet,
  });
  const fullVolumeResumeState = generationMode === "full_volume"
    ? resolveFullVolumeResumeState({
      beatPlans,
      existingBeatBlocks,
    })
    : null;
  const targetBeatIndex = generationMode === "single_beat"
    ? beatPlans.findIndex((plan) => plan.beat.key === options.targetBeatKey)
    : -1;
  if (generationMode === "single_beat" && targetBeatIndex < 0) {
    throw new Error("目标节奏段不存在，无法重生章节标题。");
  }

  const generatedBlocks: GeneratedVolumeChapterBlock[] = [];
  const plansToRun = generationMode === "single_beat"
    ? [beatPlans[targetBeatIndex]]
    : beatPlans.slice(fullVolumeResumeState?.resumeBeatIndex ?? 0);

  if (
    generationMode === "full_volume"
    && fullVolumeResumeState?.isAlreadyComplete
    && !isVolumeChapterListPartiallyPersisted(targetVolume)
  ) {
    return {
      mergedDocument: document,
      mergedWorkspace: {
        ...workspace,
        ...document,
      },
    };
  }

  for (const beatPlan of plansToRun) {
    // 已占用标题必须同时覆盖「文档中其它 beat」「resume 保留的前序 beat」「本次循环已生成的 beat」。
    // 只读取 targetVolume.chapters 快照会让后续 beat 复用前序 beat 标题而不被生成侧拦截。
    const reservedChapterTitles = Array.from(new Set([
      ...targetVolume.chapters
        .filter((chapter) => chapter.beatKey !== beatPlan.beat.key)
        .map((chapter) => chapter.title),
      ...(fullVolumeResumeState?.preservedBeatBlocks ?? [])
        .flatMap((block) => block.chapters.map((chapter) => chapter.title)),
      ...generatedBlocks.flatMap((block) => block.chapters.map((chapter) => chapter.title)),
    ]));
    await params.notifyPhase(
      generationMode === "single_beat"
        ? `正在重写第 ${targetVolume.sortOrder} 卷节奏段：${beatPlan.beat.label}`
        : `正在生成第 ${targetVolume.sortOrder} 卷节奏段：${beatPlan.beat.label}`,
    );

    const currentBeatIndex = beatPlans.findIndex((plan) => plan.beat.key === beatPlan.beat.key);
    const generatedBlock = await generateBeatChapterBlock({
      document,
      workspace,
      novel,
      reservedChapterTitles,
      storyMacroPlan,
      options,
      targetVolume,
      targetBeatSheet,
      beatPlan,
      previousBeat: currentBeatIndex > 0 ? beatPlans[currentBeatIndex - 1]?.beat ?? null : null,
      nextBeat: currentBeatIndex < beatPlans.length - 1 ? beatPlans[currentBeatIndex + 1]?.beat ?? null : null,
      previousBeatChapterSummary: buildPreviousBeatSummary({
        generationMode,
        generatedBlocks,
        existingBeatBlocks,
        preservedBeatBlocks: fullVolumeResumeState?.preservedBeatBlocks,
        targetBeatIndex: currentBeatIndex,
      }),
      preservedBeatChapterSummary: generationMode === "single_beat"
        ? buildPreservedBeatSummary({
          existingBeatBlocks,
          targetBeatIndex: currentBeatIndex,
        })
        : null,
      chapterBudgets,
    });
    generatedBlocks.push(generatedBlock);

    const intermediateDocument = mergeChapterList(
      document,
      targetVolume.id,
      targetBeatSheet,
      generatedBlocks,
      {
        generationMode,
        targetBeatKey: options.targetBeatKey,
        resumeFromBeatKey: fullVolumeResumeState?.resumeBeatKey,
        markAsPartial: true,
      },
    );
    const intermediateVolume = intermediateDocument.volumes.find((volume) => volume.id === targetVolume.id);
    if (!intermediateVolume) {
      throw new Error("当前卷章节列表已生成，但中间合并结果丢失了目标卷。");
    }
    assertChapterTitleDiversity(intermediateVolume.chapters.map((chapter) => chapter.title));
    await params.notifyIntermediateDocument?.({
      scope: "chapter_list",
      document: intermediateDocument,
      isFinal: false,
      targetVolumeId: targetVolume.id,
      targetBeatKey: beatPlan.beat.key,
      generationMode,
    });
  }

  logMemoryUsage({
    event: "before_merge",
    component: "mergeChapterList",
    taskId: options.taskId,
    novelId: document.novelId,
    stage: "structured_outline",
    itemKey: "chapter_list",
    scope: generationMode,
    entrypoint: options.entrypoint,
    volumeId: targetVolume.id,
    chapterCount: generatedBlocks.reduce((sum, block) => sum + block.chapters.length, 0),
  });
  const rawMergedDocument = generatedBlocks.length > 0
    ? mergeChapterList(
      document,
      targetVolume.id,
      targetBeatSheet,
      generatedBlocks,
      {
        generationMode,
        targetBeatKey: options.targetBeatKey,
        resumeFromBeatKey: fullVolumeResumeState?.resumeBeatKey,
        markAsPartial: false,
      },
    )
    : setVolumeChapterListPartialStatus(document, targetVolume.id, false);
  const rawMergedVolume = rawMergedDocument.volumes.find((volume) => volume.id === targetVolume.id);
  if (!rawMergedVolume) {
    throw new Error("当前卷章节列表已生成，但合并结果丢失了目标卷。");
  }
  assertChapterTitleDiversity(rawMergedVolume.chapters.map((chapter) => chapter.title));
  assertMergedVolumeChapterList({
    volume: rawMergedVolume,
    beatSheet: targetBeatSheet,
    generationMode,
    targetBeatKey: options.targetBeatKey,
  });
  const mergedDocument = isMergedVolumeChapterListComplete({
    volume: rawMergedVolume,
    beatSheet: targetBeatSheet,
  })
    ? setVolumeChapterListPartialStatus(rawMergedDocument, targetVolume.id, false)
    : setVolumeChapterListPartialStatus(rawMergedDocument, targetVolume.id, true);
  const mergedVolume = mergedDocument.volumes.find((volume) => volume.id === targetVolume.id);
  if (!mergedVolume) {
    throw new Error("当前卷章节列表已生成，但合并结果丢失了目标卷。");
  }
  logMemoryUsage({
    event: "after_merge",
    component: "mergeChapterList",
    taskId: options.taskId,
    novelId: document.novelId,
    stage: "structured_outline",
    itemKey: "chapter_list",
    scope: generationMode,
    entrypoint: options.entrypoint,
    volumeId: targetVolume.id,
    volumeCount: mergedDocument.volumes.length,
    chapterCount: mergedDocument.volumes.reduce((sum, volume) => sum + volume.chapters.length, 0),
    beatSheetCount: mergedDocument.beatSheets.length,
  });
  await params.notifyIntermediateDocument?.({
    scope: "chapter_list",
    document: mergedDocument,
    isFinal: true,
    targetVolumeId: targetVolume.id,
    targetBeatKey: generatedBlocks[generatedBlocks.length - 1]?.beatKey,
    generationMode,
  });

  return {
    mergedDocument,
    mergedWorkspace: {
      ...workspace,
      ...mergedDocument,
    },
  };
}
