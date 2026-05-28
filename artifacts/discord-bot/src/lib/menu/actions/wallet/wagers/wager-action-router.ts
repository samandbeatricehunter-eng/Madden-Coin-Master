import type { RoutedInteraction } from "../../../../interactions/router.js";
import {
  backToWagerSpread,
  backToWagerTeam,
  pickWagerTeam,
  selectWagerGame,
  selectWagerOpponent,
  selectWagerSpread,
  sendWagerChallenge,
  showWagerAmountModal,
  showWagerGameSelect,
  submitWagerAmount,
} from "./wager-service.js";

export async function routeWagerAction(interaction: RoutedInteraction): Promise<boolean> {
  const id = interaction.customId;

  if (id === "ac_wager" && interaction.isButton()) {
    await showWagerGameSelect(interaction);
    return true;
  }
  if (id === "ac_wager_game" && interaction.isStringSelectMenu()) {
    await selectWagerGame(interaction);
    return true;
  }
  if (id.startsWith("ac_wager_pick:") && interaction.isButton()) {
    await pickWagerTeam(interaction);
    return true;
  }
  if (id === "ac_wager_spread" && interaction.isStringSelectMenu()) {
    await selectWagerSpread(interaction);
    return true;
  }
  if (id === "ac_wager_back_to_team" && interaction.isButton()) {
    await backToWagerTeam(interaction);
    return true;
  }
  if (id === "ac_wager_spread_next" && interaction.isButton()) {
    await showWagerAmountModal(interaction);
    return true;
  }
  if (id === "ac_modal_wageramount" && interaction.isModalSubmit()) {
    await submitWagerAmount(interaction);
    return true;
  }
  if ((id === "ac_wager_opponent_afc" || id === "ac_wager_opponent_nfc") && interaction.isStringSelectMenu()) {
    await selectWagerOpponent(interaction);
    return true;
  }
  if (id === "ac_wager_back_to_spread" && interaction.isButton()) {
    await backToWagerSpread(interaction);
    return true;
  }
  if (id === "ac_wager_send" && interaction.isButton()) {
    await sendWagerChallenge(interaction);
    return true;
  }

  return false;
}
