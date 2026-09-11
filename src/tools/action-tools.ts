import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "typebox";

import { ActionAuthorizationError } from "../actions/errors.js";
import type {
  AuthorizedActionInvoker,
  AuthorizedActionResult,
} from "../actions/runtime.js";

export interface ActionToolDetails {
  readonly actionId: string;
  readonly result: AuthorizedActionResult;
}

export function createActionTools(
  invoker: AuthorizedActionInvoker,
): readonly AgentTool<TSchema, ActionToolDetails>[] {
  const descriptors = invoker.listAuthorizedActions();
  if (descriptors.length === 0) {
    return [];
  }

  const allowed = new Set(descriptors.map((descriptor) => descriptor.id));
  const listing = descriptors
    .map((descriptor) => `${descriptor.id}: ${descriptor.description}`)
    .join("\n");
  const parameters = Type.Object(
    {
      actionId: Type.String({
        description: "Exact identifier of an allowlisted configured action",
      }),
    },
    { additionalProperties: false },
  );

  const tool: AgentTool<typeof parameters, ActionToolDetails> = {
    name: "invoke_configured_action",
    label: "Configured Action",
    description:
      "Invoke exactly one preconfigured, allowlisted action. No command, executable, arguments, URL, or path can be supplied. Available actions:\n" +
      listing,
    parameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      if (!allowed.has(params.actionId)) {
        throw new ActionAuthorizationError(
          `Action '${params.actionId}' is not authorized for agent use`,
          { actionId: params.actionId },
        );
      }
      const result = await invoker.invokeAuthorizedAction(
        params.actionId,
        signal,
      );
      return {
        content: [
          {
            type: "text",
            text: `Configured action '${params.actionId}' completed`,
          },
        ],
        details: { actionId: params.actionId, result },
      };
    },
  };
  return [tool];
}
