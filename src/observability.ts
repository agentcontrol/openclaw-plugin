import { randomBytes } from "node:crypto";
import { trace } from "@opentelemetry/api";
import type {
  AgentControlClient,
  ConditionNodeOutput,
  Control,
  ControlExecutionEvent,
  EvaluationResponse,
} from "agent-control";
import { formatAgentControlError } from "./logging.ts";
import { isRecord } from "./shared.ts";
import type { ControlObservabilityIdentity, PluginLogger } from "./types.ts";

type TraceContext = {
  traceId: string;
  spanId: string;
};

type EventCategory = "match" | "error" | "non_match";

type ControlMatchRecord = NonNullable<EvaluationResponse["matches"]>[number];

type BuildControlExecutionEventsParams = {
  evaluation: EvaluationResponse;
  agentName: string;
  stepName: string;
  stepType: string;
  checkStage: "pre" | "post";
  traceContext: TraceContext;
  controlObservabilityById: Map<number, ControlObservabilityIdentity>;
  sourceAgentId: string;
  pluginId: string;
  runId?: string;
  toolCallId?: string;
};

type EmitControlExecutionEventsParams = {
  client: Pick<AgentControlClient, "observability">;
  logger: PluginLogger;
  events: ControlExecutionEvent[];
  agentName: string;
  stepName: string;
};

function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

export function resolveTraceContext(): TraceContext {
  const activeSpan = trace.getActiveSpan();
  const spanContext = activeSpan?.spanContext();
  if (spanContext && trace.isSpanContextValid(spanContext)) {
    return {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
    };
  }

  return {
    traceId: generateTraceId(),
    spanId: generateSpanId(),
  };
}

function isRenderedControl(
  control: Control["control"],
): control is Extract<Control["control"], { condition: ConditionNodeOutput }> {
  return isRecord(control) && "condition" in control;
}

function visitConditionLeaves(
  condition: ConditionNodeOutput,
  visit: (identity: { evaluatorName: string; selectorPath: string }) => void,
): void {
  const selectorPath = condition.selector?.path?.trim() || "*";
  const evaluatorName = condition.evaluator?.name?.trim();

  if (evaluatorName) {
    visit({ evaluatorName, selectorPath });
    return;
  }

  for (const child of condition.and ?? []) {
    visitConditionLeaves(child, visit);
  }
  for (const child of condition.or ?? []) {
    visitConditionLeaves(child, visit);
  }
  if (condition.not) {
    visitConditionLeaves(condition.not, visit);
  }
}

function buildControlObservabilityIdentity(
  condition: ConditionNodeOutput,
): ControlObservabilityIdentity {
  const allEvaluators: string[] = [];
  const allSelectorPaths: string[] = [];
  const seenEvaluators = new Set<string>();
  const seenSelectorPaths = new Set<string>();
  let leafCount = 0;

  visitConditionLeaves(condition, ({ evaluatorName, selectorPath }) => {
    leafCount += 1;

    if (!seenEvaluators.has(evaluatorName)) {
      seenEvaluators.add(evaluatorName);
      allEvaluators.push(evaluatorName);
    }
    if (!seenSelectorPaths.has(selectorPath)) {
      seenSelectorPaths.add(selectorPath);
      allSelectorPaths.push(selectorPath);
    }
  });

  return {
    selectorPath: allSelectorPaths[0] ?? null,
    evaluatorName: allEvaluators[0] ?? null,
    leafCount,
    allEvaluators,
    allSelectorPaths,
  };
}

export function buildControlObservabilityIndex(
  controls: Control[] | null | undefined,
): Map<number, ControlObservabilityIdentity> {
  const index = new Map<number, ControlObservabilityIdentity>();

  for (const control of controls ?? []) {
    if (!isRenderedControl(control.control)) {
      continue;
    }

    index.set(control.id, buildControlObservabilityIdentity(control.control.condition));
  }

  return index;
}

function mapAppliesTo(stepType: string): "llm_call" | "tool_call" {
  return stepType === "tool" ? "tool_call" : "llm_call";
}

function buildEventMetadata(
  match: ControlMatchRecord,
  identity: ControlObservabilityIdentity | undefined,
  params: BuildControlExecutionEventsParams,
): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};

  if (isRecord(match.result.metadata)) {
    Object.assign(metadata, match.result.metadata);
  }

  if (identity) {
    metadata.primary_evaluator = identity.evaluatorName;
    metadata.primary_selector_path = identity.selectorPath;
    metadata.leaf_count = identity.leafCount;
    metadata.all_evaluators = identity.allEvaluators;
    metadata.all_selector_paths = identity.allSelectorPaths;
  }

  metadata.openclaw_step_name = params.stepName;
  metadata.openclaw_step_type = params.stepType;
  metadata.openclaw_source_agent_id = params.sourceAgentId;
  metadata.openclaw_plugin_id = params.pluginId;
  if (params.runId) {
    metadata.openclaw_run_id = params.runId;
  }
  if (params.toolCallId) {
    metadata.openclaw_tool_call_id = params.toolCallId;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function buildEventsForCategory(
  matches: EvaluationResponse["matches"] | EvaluationResponse["errors"] | EvaluationResponse["nonMatches"],
  category: EventCategory,
  params: BuildControlExecutionEventsParams,
): ControlExecutionEvent[] {
  const categoryMatches = matches ?? [];
  const matched = category === "match";
  const includeErrorMessage = category === "error";

  return categoryMatches.map((match) => {
    const identity = params.controlObservabilityById.get(match.controlId);

    return {
      action: match.action,
      agentName: params.agentName,
      appliesTo: mapAppliesTo(params.stepType),
      checkStage: params.checkStage,
      confidence: match.result.confidence,
      controlExecutionId: match.controlExecutionId,
      controlId: match.controlId,
      controlName: match.controlName,
      errorMessage: includeErrorMessage ? match.result.error ?? null : null,
      evaluatorName: identity?.evaluatorName ?? null,
      matched,
      metadata: buildEventMetadata(match, identity, params),
      selectorPath: identity?.selectorPath ?? null,
      spanId: params.traceContext.spanId,
      timestamp: new Date(),
      traceId: params.traceContext.traceId,
    };
  });
}

export function buildControlExecutionEvents(
  params: BuildControlExecutionEventsParams,
): ControlExecutionEvent[] {
  return [
    ...buildEventsForCategory(params.evaluation.matches, "match", params),
    ...buildEventsForCategory(params.evaluation.errors, "error", params),
    ...buildEventsForCategory(params.evaluation.nonMatches, "non_match", params),
  ];
}

export function emitControlExecutionEvents(params: EmitControlExecutionEventsParams): void {
  if (params.events.length === 0) {
    return;
  }

  void params.client.observability
    .ingestEvents({ events: params.events })
    .then((response) => {
      if (response.status !== "queued" || response.dropped > 0) {
        params.logger.warn(
          `agent-control: observability_ingest partial agent=${params.agentName} step=${params.stepName} status=${response.status} enqueued=${response.enqueued} dropped=${response.dropped}`,
        );
        return;
      }

      params.logger.debug(
        `agent-control: observability_ingest agent=${params.agentName} step=${params.stepName} received=${response.received} enqueued=${response.enqueued}`,
      );
    })
    .catch((error) => {
      params.logger.warn(
        `agent-control: observability_ingest failed agent=${params.agentName} step=${params.stepName} error=${formatAgentControlError(error)}`,
      );
    });
}
