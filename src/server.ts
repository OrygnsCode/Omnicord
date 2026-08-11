import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION, type OmnicordConfig } from "./config.js";
import { registerDiagnostics } from "./tools/diagnostics.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { registerBuilderTools } from "./tools/builder.js";
import { registerManageTools } from "./tools/manage.js";
import { registerModerationTools } from "./tools/moderation.js";
import { registerReactionTools } from "./tools/reactions.js";
import { registerCommunityTools } from "./tools/community.js";
import { registerEventTools } from "./tools/events.js";
import { registerRealtimeTools } from "./tools/realtime.js";
import { registerThreadTools } from "./tools/threads.js";
import { registerForumTools } from "./tools/forums.js";
import { registerAutomodTools } from "./tools/automod.js";
import { registerSettingsTools } from "./tools/settings.js";
import { registerExpressionTools } from "./tools/expressions.js";
import { registerBlueprintTools } from "./tools/blueprints.js";
import { registerMessagingTools } from "./tools/messaging.js";
import { registerMemberTools } from "./tools/members.js";
import { registerPermissionTools } from "./tools/permissions.js";
import { registerStructureTools } from "./tools/structure.js";
import { registerStageTools } from "./tools/stages.js";
import { registerRosterTools } from "./tools/roster.js";
import { registerAppCommandTools } from "./tools/appCommands.js";

// Applies the toolset selection without touching the tool modules.
//
// Every module reaches for exactly one method on the server, registerTool,
// and none of them uses its return value. So the whole filter is a proxy that
// drops registrations for tools outside the selection and forwards everything
// else untouched. Tools that are filtered out are never registered at all,
// which keeps them out of tools/list and out of the client's context.
//
// The stub stands in for the RegisteredTool a caller would normally get back.
// Nothing reads it today; returning a disabled handle rather than undefined
// means a future caller that does read it finds something coherent.
function applyToolsets(server: McpServer, allowed: ReadonlySet<string>): McpServer {
  const stub = {
    enabled: false,
    enable() {},
    disable() {},
    remove() {},
    update() {},
  } as unknown as ReturnType<McpServer["registerTool"]>;

  return new Proxy(server, {
    get(target, prop) {
      if (prop === "registerTool") {
        return (name: string, ...rest: unknown[]) => {
          if (!allowed.has(name)) return stub;
          return (
            target.registerTool as unknown as (
              n: string,
              ...r: unknown[]
            ) => ReturnType<McpServer["registerTool"]>
          )(name, ...rest);
        };
      }
      // Read and bind against the real server, never the proxy, so getters
      // and methods that touch private fields still resolve.
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// Builds a fully wired McpServer. A factory rather than a singleton
// because the Streamable HTTP transport needs one server instance per
// session, while stdio needs exactly one for the process lifetime.
export function buildServer(config: OmnicordConfig): McpServer {
  const real = new McpServer({ name: "omnicord", version: VERSION });
  // With no OMNICORD_TOOLS set the selection holds every tool, so this is a
  // pass-through and the registered surface is identical to before.
  const server = applyToolsets(real, config.toolsets.tools);
  registerDiagnostics(server, config);
  registerReadTools(server, config);
  registerWriteTools(server, config);
  registerBuilderTools(server, config);
  registerManageTools(server, config);
  registerModerationTools(server, config);
  registerReactionTools(server, config);
  registerCommunityTools(server, config);
  registerEventTools(server, config);
  registerRealtimeTools(server, config);
  registerThreadTools(server, config);
  registerForumTools(server, config);
  registerAutomodTools(server, config);
  registerSettingsTools(server, config);
  registerExpressionTools(server, config);
  registerBlueprintTools(server, config);
  registerMessagingTools(server, config);
  registerMemberTools(server, config);
  registerPermissionTools(server, config);
  registerStructureTools(server, config);
  registerStageTools(server, config);
  registerRosterTools(server, config);
  registerAppCommandTools(server, config);
  // Hand back the real server: the proxy exists only to gate registration.
  return real;
}
