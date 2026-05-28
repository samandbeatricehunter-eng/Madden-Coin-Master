import type {
  ButtonInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from "discord.js";

import {
  handleCcpApplied,
  handleCcpAppearanceModal,
  handleCcpArch,
  handleCcpArchNext,
  handleCcpArchPick,
  handleCcpArchPrev,
  handleCcpAttrAdjust,
  handleCcpAttrPageNext,
  handleCcpAttrPagePrev,
  handleCcpAttrSel,
  handleCcpAttrSelNext,
  handleCcpAttrSelPrev,
  handleCcpCancel,
  handleCcpConfirm,
  handleCcpDev,
  handleCcpHand,
  handleCcpHeight,
  handleCcpModal,
  handleCcpMotionStyle,
  handleCcpOlPos,
  handleCcpPkg,
  handleCcpPos,
  handleCcpPreConfirm,
  handleCcpQbDetailsModal,
  handleCcpRefund,
  handleCcpRefundModal,
  handleCcpSubmitAttrs,
  handleCcpWeight,
} from "../../../../../handlers/custom-player-interactions.js";

export type CustomPlayerWizardInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ModalSubmitInteraction;

const CCP_PREFIX = "ccp_";

export function isCustomPlayerWizardInteraction(customId: string): boolean {
  return customId.startsWith(CCP_PREFIX);
}

function splitCustomId(customId: string) {
  const parts = customId.split(":");
  return {
    action: parts[0] ?? "",
    id: parts[1] ?? "",
    parts,
  };
}

function assertButton(interaction: CustomPlayerWizardInteraction): asserts interaction is ButtonInteraction {
  if (!interaction.isButton()) {
    throw new Error(`Custom player action ${interaction.customId} expected a button interaction.`);
  }
}

function assertSelect(interaction: CustomPlayerWizardInteraction): asserts interaction is StringSelectMenuInteraction {
  if (!interaction.isStringSelectMenu()) {
    throw new Error(`Custom player action ${interaction.customId} expected a string select interaction.`);
  }
}

function assertModal(interaction: CustomPlayerWizardInteraction): asserts interaction is ModalSubmitInteraction {
  if (!interaction.isModalSubmit()) {
    throw new Error(`Custom player action ${interaction.customId} expected a modal submit interaction.`);
  }
}

async function replyWrongInteractionType(interaction: CustomPlayerWizardInteraction, error: unknown) {
  const message = error instanceof Error ? error.message : "Invalid custom player interaction type.";
  const payload = {
    content: `❌ ${message}`,
    ephemeral: true,
  };

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload).catch(() => undefined);
    return;
  }

  await interaction.reply(payload).catch(() => undefined);
}

/**
 * Central boundary for the existing ccp_* custom player wizard.
 *
 * This phase intentionally delegates to the already-working legacy handlers while
 * removing ccp_* routing from interactionCreate.ts. Later phases can move handler
 * bodies behind this boundary without changing any Discord custom IDs.
 */
export async function handleCustomPlayerWizardInteraction(
  interaction: CustomPlayerWizardInteraction,
): Promise<boolean> {
  if (!isCustomPlayerWizardInteraction(interaction.customId)) return false;

  const { action, id } = splitCustomId(interaction.customId);

  try {
    switch (action) {
      case "ccp_apage_prev":
        assertButton(interaction);
        await handleCcpAttrPagePrev(interaction, id);
        return true;
      case "ccp_apage_next":
        assertButton(interaction);
        await handleCcpAttrPageNext(interaction, id);
        return true;
      case "ccp_arch_prev":
        assertButton(interaction);
        await handleCcpArchPrev(interaction, id);
        return true;
      case "ccp_arch_next":
        assertButton(interaction);
        await handleCcpArchNext(interaction, id);
        return true;
      case "ccp_arch_pick":
        assertButton(interaction);
        await handleCcpArchPick(interaction, id);
        return true;
      case "ccp_asel_prev":
        assertButton(interaction);
        await handleCcpAttrSelPrev(interaction, id);
        return true;
      case "ccp_asel_next":
        assertButton(interaction);
        await handleCcpAttrSelNext(interaction, id);
        return true;
      case "ccp_attr_plus1":
        assertButton(interaction);
        await handleCcpAttrAdjust(interaction, id, 1);
        return true;
      case "ccp_attr_minus1":
        assertButton(interaction);
        await handleCcpAttrAdjust(interaction, id, -1);
        return true;
      case "ccp_submit_attrs":
        assertButton(interaction);
        await handleCcpSubmitAttrs(interaction, id);
        return true;
      case "ccp_preconfirm":
        assertButton(interaction);
        await handleCcpPreConfirm(interaction, id);
        return true;
      case "ccp_confirm":
        assertButton(interaction);
        await handleCcpConfirm(interaction, id);
        return true;
      case "ccp_cancel":
        assertButton(interaction);
        await handleCcpCancel(interaction, id);
        return true;
      case "ccp_applied":
        assertButton(interaction);
        await handleCcpApplied(interaction, id);
        return true;
      case "ccp_refund":
        assertButton(interaction);
        await handleCcpRefund(interaction, id);
        return true;
      case "ccp_pos":
        assertSelect(interaction);
        await handleCcpPos(interaction, id);
        return true;
      case "ccp_arch":
        assertSelect(interaction);
        await handleCcpArch(interaction, id);
        return true;
      case "ccp_ol_pos":
        assertSelect(interaction);
        await handleCcpOlPos(interaction, id);
        return true;
      case "ccp_motion_style":
        assertSelect(interaction);
        await handleCcpMotionStyle(interaction, id);
        return true;
      case "ccp_dev":
        assertSelect(interaction);
        await handleCcpDev(interaction, id);
        return true;
      case "ccp_pkg":
        assertSelect(interaction);
        await handleCcpPkg(interaction, id);
        return true;
      case "ccp_attr_sel":
        assertSelect(interaction);
        await handleCcpAttrSel(interaction, id);
        return true;
      case "ccp_hand":
        assertSelect(interaction);
        await handleCcpHand(interaction, id);
        return true;
      case "ccp_height":
        assertSelect(interaction);
        await handleCcpHeight(interaction, id);
        return true;
      case "ccp_weight":
        assertSelect(interaction);
        await handleCcpWeight(interaction, id);
        return true;
      case "ccp_modal":
        assertModal(interaction);
        await handleCcpModal(interaction, id);
        return true;
      case "ccp_refund_modal":
        assertModal(interaction);
        await handleCcpRefundModal(interaction, id);
        return true;
      case "ccp_qb_details_modal":
        assertModal(interaction);
        await handleCcpQbDetailsModal(interaction, id);
        return true;
      case "ccp_appearance_modal":
        assertModal(interaction);
        await handleCcpAppearanceModal(interaction, id);
        return true;
      default:
        return false;
    }
  } catch (error) {
    await replyWrongInteractionType(interaction, error);
    return true;
  }
}
