import * as Layer from "effect/Layer";
import { Application } from "./application.ts";
import { Autonomy } from "./autonomy.ts";
import { Chatgpt } from "./chatgpt.ts";
import { ComputerResume } from "./computer-resume.ts";
import { DesktopFiles } from "./desktop-files.ts";
import { Lifecycle } from "./lifecycle.ts";
import { Notifications } from "./notifications.ts";
import { OAuth } from "./oauth.ts";
import { OwnerData } from "./owner-data.ts";
import { Recovery } from "./recovery.ts";
import { Webhooks } from "./webhooks.ts";
import { WorkspaceData } from "./workspace-data.ts";

// One shared acquisition per Worker: application routes, RPCs, and cron handlers
// use the same captured actor clients and workflow runners.
export const GatewayServices = Application.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Autonomy.layer,
      Chatgpt.layer,
      ComputerResume.layer,
      DesktopFiles.layer,
      Lifecycle.layer,
      Notifications.layer,
      OAuth.layer,
      OwnerData.layer,
      Recovery.layer,
      Webhooks.layer,
      WorkspaceData.layer,
    ),
  ),
);
