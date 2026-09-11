import { ActionNotFoundError } from "./errors.js";
import type { ExecutableActionRegistry } from "./executable-actions.js";

export interface AuthorizedActionDescriptor {
  readonly id: string;
  readonly description: string;
}

export interface AuthorizedActionResult {
  readonly actionId: string;
  readonly kind: "executable";
  readonly output: unknown;
}

export interface AuthorizedActionInvoker {
  listAuthorizedActions(): readonly AuthorizedActionDescriptor[];
  invokeAuthorizedAction(
    actionId: string,
    signal?: AbortSignal,
  ): Promise<AuthorizedActionResult>;
}

export interface ActionRuntimeOptions {
  readonly executables?: ExecutableActionRegistry;
}

export class ActionRuntime implements AuthorizedActionInvoker {
  readonly #executables: ExecutableActionRegistry | undefined;

  constructor(options: ActionRuntimeOptions) {
    this.#executables = options.executables;
  }

  listAuthorizedActions(): readonly AuthorizedActionDescriptor[] {
    return (
      this.#executables?.configuredAgentActions().map((action) => ({
        id: `executable:${action.id}`,
        description:
          action.description ?? `Run configured executable action '${action.id}'`,
      })) ?? []
    );
  }

  async invokeAuthorizedAction(
    actionId: string,
    signal?: AbortSignal,
  ): Promise<AuthorizedActionResult> {
    const prefix = "executable:";
    if (
      !actionId.startsWith(prefix) ||
      this.#executables === undefined ||
      actionId.length === prefix.length
    ) {
      throw new ActionNotFoundError(actionId);
    }

    const output = await this.#executables.invoke(
      actionId.slice(prefix.length),
      "agent",
      { actionId },
      signal,
    );
    return { actionId, kind: "executable", output };
  }
}
