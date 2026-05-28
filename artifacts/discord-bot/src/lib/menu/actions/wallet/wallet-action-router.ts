import type { RoutedInteraction } from "../../../interactions/router.js";
import {
  isBankTransferAction,
  isSendCoinsAction,
  isWagerAction,
  isWalletBalanceAction,
  isWalletEconomyAction,
} from "./wallet-action-ids.js";
import {
  showCoinBalance,
  showSendCoinsModal,
  showTransferAmountModal,
  showTransferMenu,
  submitSendCoins,
  submitTransfer,
} from "./wallet-service.js";
import { routeWagerAction } from "./wagers/wager-action-router.js";

/**
 * Wallet/economy action boundary.
 *
 * This extracts the proven coin balance, send-coins, savings-transfer, and
 * wager challenge creation flows from the monolithic actions handler.
 */
export async function routeWalletEconomyAction(interaction: RoutedInteraction): Promise<boolean> {
  const customId = interaction.customId;
  if (!isWalletEconomyAction(customId)) return false;

  if (isWalletBalanceAction(customId) && interaction.isButton()) {
    await showCoinBalance(interaction);
    return true;
  }

  if (isSendCoinsAction(customId)) {
    if (customId === "ac_send_coins_modal" && interaction.isButton()) {
      await showSendCoinsModal(interaction);
      return true;
    }
    if (customId === "ac_modal_sendcoins" && interaction.isModalSubmit()) {
      await submitSendCoins(interaction);
      return true;
    }
  }

  if (isBankTransferAction(customId)) {
    if (customId === "ac_transfer" && interaction.isButton()) {
      await showTransferMenu(interaction);
      return true;
    }
    if (customId.startsWith("ac_transfer_dir:") && interaction.isButton()) {
      await showTransferAmountModal(interaction);
      return true;
    }
    if (customId.startsWith("ac_modal_transfer:") && interaction.isModalSubmit()) {
      await submitTransfer(interaction);
      return true;
    }
  }

  if (isWagerAction(customId)) {
    return routeWagerAction(interaction);
  }

  return false;
}
