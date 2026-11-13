import NovelAutoDirectorCandidateBatches from "../components/NovelAutoDirectorCandidateBatches";
import NovelAutoDirectorProgressPanel from "../components/NovelAutoDirectorProgressPanel";
import { Button } from "@/components/ui/button";
import type { useAutoDirectorCreateController } from "./useAutoDirectorCreateController";
import NovelProductionExperienceHandoff from "../components/NovelProductionExperienceHandoff";
import OnboardingTip from "@/components/onboarding/OnboardingTip";
import { isProductionExperienceChoicePending } from "@/lib/novelRoutes";

type AutoDirectorCreateController = ReturnType<typeof useAutoDirectorCreateController>;

interface StageCandidatesProps {
  controller: AutoDirectorCreateController;
  onRegenerateSettings: () => void;
}

export default function StageCandidates({
  controller,
  onRegenerateSettings,
}: StageCandidatesProps) {
  const directorTask = controller.directorTask;
  if (
    directorTask
    && isProductionExperienceChoicePending(directorTask)
    && directorTask.resumeTarget?.novelId
  ) {
    return (
      <NovelProductionExperienceHandoff
        taskId={directorTask.id}
        novelId={directorTask.resumeTarget.novelId}
        novelTitle={directorTask.title}
      />
    );
  }

  if (controller.dialogMode !== "candidate_selection") {
    const isFailure = controller.dialogMode === "execution_failed";
    const rawFailure = controller.executionError || controller.directorTask?.lastError || "";
    const failureText = rawFailure.toLowerCase();
    const isRateLimit = /429|soft_rate|rate.?limit|使用量已超出|频率限制|too many requests|quota/i.test(failureText);
    const isModelUnavailable = /invalid_value for model|模型不可用|模型限流|model is not|model.*not found|model.*unavailable/i.test(failureText);
    const resetMatch = rawFailure.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s*UTC\+?8)/i)
      ?? rawFailure.match(/(?:将在\s*)?(\d{1,2}:\d{2}(?::\d{2})?\s*(?:UTC\+?8)?\s*重置)/i);
    const resetTime = resetMatch?.[1]?.trim();
    return (
      <section className="space-y-4">
        <NovelAutoDirectorProgressPanel
          mode={controller.dialogMode}
          task={controller.directorTask}
          taskId={controller.workflowTaskId}
          titleHint={controller.pendingTitleHint}
          fallbackError={controller.executionError}
          onConfirmAndContinue={() => controller.continueMutation.mutate()}
          isConfirmingAndContinuing={controller.continueMutation.isPending}
          quickRetryLabel="快速重试"
        />
        {isFailure ? (
          <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/[0.12] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1 text-sm leading-6 text-muted-foreground">
              {isRateLimit ? (
                <p>
                  这是当前<strong className="text-foreground">厂商上游限流（429）</strong>，同厂商下换模型无法解决——所有模型共用同一上游额度。
                  {resetTime ? ` 限流将在 ${resetTime} 重置。` : ""} 请切换到其它已配置厂商，或等待重置后再生成。
                </p>
              ) : isModelUnavailable ? (
                <p>所选模型不可用或已被限流，返回「模型与生产准备」换一个可用模型后重新生成即可。</p>
              ) : (
                <p>可返回上一步「模型与生产准备」检查模型与生成设置，再重新生成方向。</p>
              )}
              {isRateLimit ? (
                <p className="text-xs text-muted-foreground/80">
                  若厂商下拉里只有 workbuddy，请到系统设置 → 模型厂商中配置其它厂商的 API Key，再回来切换厂商。
                </p>
              ) : null}
            </div>
            <Button
              type="button"
              variant="outline"
              className="shrink-0"
              onClick={onRegenerateSettings}
            >
              返回修改模型与生产准备
            </Button>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section className="space-y-5">
      <OnboardingTip
        storageKey="auto-director-candidates"
        title="这里只需要判断哪本书更想读"
        description="重点比较主角欲望、核心冲突和持续爽点；标题与局部设定以后仍可调整。"
        next="确认后，AI 会继续准备角色、世界和卷章资源。"
      />
      <div className="flex flex-col gap-4 pb-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="break-words text-2xl font-semibold leading-9 text-foreground [overflow-wrap:anywhere]">方向候选</div>
          <div className="mt-1 max-w-3xl break-words text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
            先选最贴近你想法的一套方向；不满意时再展开调整或生成新一轮。
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onRegenerateSettings}
        >
          回改设定
        </Button>
      </div>
      <NovelAutoDirectorCandidateBatches
        batches={controller.batches}
        selectedPresets={controller.selectedPresets}
        feedback={controller.feedback}
        onFeedbackChange={controller.setFeedback}
        onTogglePreset={controller.togglePreset}
        candidatePatchFeedbacks={controller.candidatePatchFeedbacks}
        onCandidatePatchFeedbackChange={(candidateId, value) => controller.setCandidatePatchFeedbacks((prev) => ({
          ...prev,
          [candidateId]: value,
        }))}
        titlePatchFeedbacks={controller.titlePatchFeedbacks}
        onTitlePatchFeedbackChange={(candidateId, value) => controller.setTitlePatchFeedbacks((prev) => ({
          ...prev,
          [candidateId]: value,
        }))}
        isGenerating={controller.generateMutation.isPending}
        isPatchingCandidate={controller.patchCandidateMutation.isPending}
        isRefiningTitle={controller.refineTitleMutation.isPending}
        isConfirming={controller.confirmMutation.isPending}
        onApplyCandidateTitleOption={controller.applyCandidateTitleOption}
        onPatchCandidate={(batchId, candidate, nextFeedback) => controller.patchCandidateMutation.mutate({
          batchId,
          candidate,
          feedback: nextFeedback,
        })}
        onRefineTitle={(batchId, candidate, nextFeedback) => controller.refineTitleMutation.mutate({
          batchId,
          candidate,
          feedback: nextFeedback,
        })}
        onConfirmCandidate={controller.handleConfirmCandidate}
        onGenerateNext={() => controller.generateMutation.mutate()}
      />
    </section>
  );
}

