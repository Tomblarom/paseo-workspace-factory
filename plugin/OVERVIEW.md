Workspace Factory coordinates work across Paseo steers and workers. One steer controls each enrolled workspace. Factory records the current task, tracks worker results and carries that work forward when control changes or a session needs recovery.

## In a workspace

Open the **Factory** tab to see who is in control, what work is underway and what needs attention. **Steers** shows each agent's role, runtime, cache and quota state alongside its available actions. **Resources** shows measured quota windows and the worker profile Factory would select. **Activity** shows recent handovers, recovery and deliveries for which Factory has retained evidence. Workspace commands and their results are available under **Diagnostics**.

A handover previews the destination and asks for confirmation. Factory checks the current controller, destination and workspace state again when you confirm. Reset and resume behavior depends on the provider and the workspace's settings. Review the preview when an operation can clear or rewind chat history.

## Host settings

Open **Settings → Plugins → Workspace Factory** to configure reusable model profiles and separate priorities for steers, advisors and workers. Profiles apply to future routing and creation. Running agents use their native Paseo settings. Factory can use ZeroSub account and quota evidence when the integration is available.

The plugin requires Paseo 0.17.1 or later. Git and GitHub tools are used by the operations that discover or enroll GitHub repositories. Local workspaces can also be enrolled. The plugin reads Paseo and repository state and writes workspace metadata, plans and agent changes on its host.

[Getting started](https://github.com/Tomblarom/paseo-workspace-factory/blob/main/docs/getting-started.md#quickstart-in-paseo)
