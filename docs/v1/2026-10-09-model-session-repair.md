# Native model initialization repair

User's real model turn failed during deployment:persona-prefix assembly with missing {{model}}. The launch adapter directly used agents.create without the host Session Controller's agentOptions and model-selection setup. The installed controller's create({sessionId,workspaceId,agentPreset}) mounts the preset and installs model selection before publication.

The adapter now uses sessionController.create followed by resolveAgent on supported hosts. Existing cold restoration continues through resolveAgent. Minimal older/fake-host fallback remains. Regression first failed when direct agents.create was used, then passed with the controller path. Fresh packaged verify:home passed on the real host. Desktop restarted with the repair. No model message was sent by this agent; actual model answer remains to be confirmed by the user.
