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

// Builds a fully wired McpServer. A factory rather than a singleton
// because the Streamable HTTP transport needs one server instance per
// session, while stdio needs exactly one for the process lifetime.
export function buildServer(config: OmnicordConfig): McpServer {
  const server = new McpServer({ name: "omnicord", version: VERSION });
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
  return server;
}
