# Hand over when a provider reaches its limit

When the active steer reaches its provider limit, use the Paseo composer to move coordination to an available steer. The handoff carries the checkpoint and current git state.

## Check the work and prepare a target

1. Run `/factory status` in the project workspace. Check the active slot, the checkpoint, and the available steers. Choose an idle steer with remaining quota or a different provider. `/factory quota` shows the available quota data.
2. If you need a second steer, run `/factory steer add B`. Review the chosen profile and confirm in the Factory panel. The new tab is available for a handoff once it is idle.
3. To use an existing tab, name it `Steer B` after its first message. In the same workspace, run `/factory plan --adopt B=<agent-id>` and confirm the plan. The preview should identify that agent and its current model.

## Save the checkpoint and switch

1. If the checkpoint already reflects the current work, use it. Otherwise run `/factory checkpoint --from-agent <steer-id>` and confirm. If the interrupted answer has no CHECKPOINT block, use `/factory checkpoint --task "Current work" --next "Next step"` and add the known tests and blockers.
2. Run `/factory switch --to B`. Review the handoff preview, then select **Switch and deliver**. The switch can run from an available composer in the workspace while the old steer is in cooldown.
3. Run `/factory status`. It should show B as active and the epoch should have advanced by one. Open B's tab to read the handoff and its reply. If delivery fails after the switch, use the previewed handoff to brief B in that tab.

If the target is busy, wait until it is idle. If the active steer is still running, let its current turn finish or stop it before switching. If there are several candidates for a slot, review the conflict details in the plan before choosing one.

## Return after cooldown

In a registered steer's tab, use `/factory resume --brief` to inspect the checkpoint. Use **Resume now** or `/factory resume` when you want that steer to resume. Resuming an eligible inactive steer can make it active, so check the current coordinator before doing so. [Resume behavior](design/cold-context-resume.md#r--factory-resume-as-the-restart-path)
