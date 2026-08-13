import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";

import type {
  ActionableError,
  CoreModule,
  ManifestSource,
  ProjectStatusManifest,
  ValidationError,
  ValidationResult,
} from "./types.js";

const CORE_MODULE_URL = new URL("../../core/index.mjs", import.meta.url);
let corePromise: Promise<CoreModule> | undefined;

class ManifestAccessError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly nextAction: string,
  ) {
    super(message);
    this.name = "ManifestAccessError";
  }
}

async function coreModule(): Promise<CoreModule> {
  corePromise ??= import(CORE_MODULE_URL.href) as Promise<CoreModule>;
  return corePromise;
}

export function resolveManifestPath(options: {
  explicitPath?: string;
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}): string {
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configured = options.explicitPath
    ?? environment.PROJECT_STATUS_MANIFEST
    ?? resolve(environment.PROJECT_STATUS_ROOT ?? cwd, ".project-status", "manifest.json");
  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}

export function createFileManifestSource(filePath: string): ManifestSource {
  return {
    async load(): Promise<unknown> {
      let source: string;
      try {
        source = await readFile(filePath, "utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          throw new ManifestAccessError(
            "manifest_not_found",
            "The configured Project Status manifest was not found.",
            "Set PROJECT_STATUS_ROOT or PROJECT_STATUS_MANIFEST to a workspace containing .project-status/manifest.json.",
          );
        }
        throw new ManifestAccessError(
          "manifest_unreadable",
          "The configured Project Status manifest could not be read.",
          "Confirm the MCP process has read permission for the configured manifest.",
        );
      }
      try {
        return JSON.parse(source) as unknown;
      } catch {
        throw new ManifestAccessError(
          "invalid_json",
          "The configured Project Status manifest is not valid JSON.",
          "Repair the JSON syntax, then call project_status_validate_manifest again.",
        );
      }
    },
  };
}

export function createWorkspaceRootsManifestSource(rootUris: string[]): ManifestSource {
  const candidates = rootUris.flatMap((rootUri) => {
    try {
      const url = new URL(rootUri);
      if (url.protocol !== "file:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return [];
      return [resolve(fileURLToPath(url), ".project-status", "manifest.json")];
    } catch {
      return [];
    }
  });
  return {
    async load(): Promise<unknown> {
      for (const candidate of candidates) {
        try {
          return await createFileManifestSource(candidate).load();
        } catch (error) {
          if (error instanceof ManifestAccessError && error.code === "manifest_not_found") continue;
          throw error;
        }
      }
      throw new ManifestAccessError(
        "manifest_not_found_in_roots",
        "No Project Status manifest was found in the workspace roots provided by the MCP host.",
        "Attach the Project Status skill in a workspace containing .project-status/manifest.json, or set PROJECT_STATUS_ROOT explicitly.",
      );
    },
  };
}

export interface ManifestService {
  load(): Promise<unknown>;
  validate(manifest: unknown): Promise<ValidationResult>;
  loadValidated(): Promise<ProjectStatusManifest>;
  calculate(manifest: ProjectStatusManifest): Promise<Record<string, unknown>>;
  publicProjection(manifest: ProjectStatusManifest): Promise<Record<string, unknown>>;
}

export function createManifestService(source: ManifestSource): ManifestService {
  return {
    load: () => source.load(),
    async validate(manifest: unknown): Promise<ValidationResult> {
      return (await coreModule()).validateManifest(manifest);
    },
    async loadValidated(): Promise<ProjectStatusManifest> {
      const manifest = await source.load();
      const validation = (await coreModule()).validateManifest(manifest);
      if (!validation.valid) {
        throw new ManifestAccessError(
          "manifest_validation_failed",
          `The Project Status manifest failed validation with ${validation.errors.length} error(s).`,
          "Call project_status_validate_manifest for field-level errors, repair the manifest, and retry.",
        );
      }
      return manifest as ProjectStatusManifest;
    },
    async calculate(manifest: ProjectStatusManifest): Promise<Record<string, unknown>> {
      return (await coreModule()).calculateStatus(manifest);
    },
    async publicProjection(manifest: ProjectStatusManifest): Promise<Record<string, unknown>> {
      return (await coreModule()).createPublicProjection(manifest);
    },
  };
}

export function actionableError(error: unknown): ActionableError {
  if (error instanceof ManifestAccessError) {
    return { code: error.code, message: error.message, nextAction: error.nextAction };
  }
  if (
    error !== null
    && typeof error === "object"
    && typeof (error as Partial<ActionableError>).code === "string"
    && typeof (error as Partial<ActionableError>).message === "string"
    && typeof (error as Partial<ActionableError>).nextAction === "string"
  ) {
    return {
      code: (error as ActionableError).code,
      message: (error as ActionableError).message,
      nextAction: (error as ActionableError).nextAction,
    };
  }
  return {
    code: "manifest_operation_failed",
    message: "The Project Status manifest operation failed.",
    nextAction: "Validate the manifest and confirm the MCP server can read its configured workspace.",
  };
}

export function boundedValidationErrors(errors: ValidationError[], limit = 50): {
  errors: ValidationError[];
  truncated: boolean;
} {
  return { errors: errors.slice(0, limit), truncated: errors.length > limit };
}
