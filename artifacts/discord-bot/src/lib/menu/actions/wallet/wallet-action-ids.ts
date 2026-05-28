export const WALLET_ACTION_IDS = {
  coins: "ac_coins",
  sendCoinsModal: "ac_send_coins_modal",
  transfer: "ac_transfer",
  transferDirectionPrefix: "ac_transfer_dir:",
  sendCoinsSubmit: "ac_modal_sendcoins",
  transferSubmitPrefix: "ac_modal_transfer:",
  wager: "ac_wager",
  wagerGame: "ac_wager_game",
  wagerSpread: "ac_wager_spread",
  wagerSpreadNext: "ac_wager_spread_next",
  wagerBackToTeam: "ac_wager_back_to_team",
  wagerBackToSpread: "ac_wager_back_to_spread",
  wagerOpponentAfc: "ac_wager_opponent_afc",
  wagerOpponentNfc: "ac_wager_opponent_nfc",
  wagerSend: "ac_wager_send",
} as const;

export function isWalletBalanceAction(customId: string): boolean {
  return customId === WALLET_ACTION_IDS.coins;
}

export function isSendCoinsAction(customId: string): boolean {
  return customId === WALLET_ACTION_IDS.sendCoinsModal || customId === WALLET_ACTION_IDS.sendCoinsSubmit;
}

export function isBankTransferAction(customId: string): boolean {
  return (
    customId === WALLET_ACTION_IDS.transfer ||
    customId.startsWith(WALLET_ACTION_IDS.transferDirectionPrefix) ||
    customId.startsWith(WALLET_ACTION_IDS.transferSubmitPrefix)
  );
}

export function isWagerAction(customId: string): boolean {
  return (
    customId === WALLET_ACTION_IDS.wager ||
    customId === WALLET_ACTION_IDS.wagerGame ||
    customId === WALLET_ACTION_IDS.wagerSpread ||
    customId === WALLET_ACTION_IDS.wagerSpreadNext ||
    customId === WALLET_ACTION_IDS.wagerBackToTeam ||
    customId === WALLET_ACTION_IDS.wagerBackToSpread ||
    customId === WALLET_ACTION_IDS.wagerOpponentAfc ||
    customId === WALLET_ACTION_IDS.wagerOpponentNfc ||
    customId === WALLET_ACTION_IDS.wagerSend ||
    customId.startsWith("ac_wager_pick:") ||
    customId.startsWith("ac_modal_wageramount")
  );
}

export function isWalletEconomyAction(customId: string): boolean {
  return isWalletBalanceAction(customId) || isSendCoinsAction(customId) || isBankTransferAction(customId) || isWagerAction(customId);
}
