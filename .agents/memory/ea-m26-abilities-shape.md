---
name: EA Madden 26 abilities export shape
description: Where Superstar / X-Factor ability names actually live in the EA MCA Blaze roster export, and how to interpret slot unlock state.
---

EA's Madden 26 MCA Blaze roster export (`CareerMode_GetTeamRostersExport`) returns abilities under a player field named **`signatureSlotList`** — not `activeAbilityList`, `abilities`, `superstarAbilityList`, or any of the other names a "try every key" parser would guess. Shape (confirmed via live probe):

```
signatureSlotList: [
  { isEmpty: false, locked: false, ovrThreshold: 75,
    signatureAbility: {
      signatureTitle:       "Edge Threat",     // ← the human-readable ability name
      signatureDescription: "...",
      signatureLogoId:      1132,
      rank:                 "ABILITY_BRONZE",   // ABILITY_BRONZE | _SILVER | _GOLD | _PLATINUM
      isPassive:            false,
      activationEnabled:    false,
      isUnlocked:           false,
      // ... activation/deactivation/marketplace metadata
    } },
  ...
]
```

**Why a naive parser misses it:**
- The name is `signatureTitle`, not `name` / `abilityName` / `label` / `displayName`.
- It's nested under `signatureAbility`, not `ability`.
- The slot wrapper has no name field of its own — only `isEmpty`, `locked`, `ovrThreshold`, and the nested `signatureAbility` object.

**How to interpret slot state (this is the non-obvious part):**
- `signatureSlotList` is *position-templated*. Every player at a position gets the same 3-ish slots regardless of OVR — e.g. every Edge gets Edge Threat / No Outsiders / Inside Stuff slots.
- What makes a slot actually *available to the player* is `ovrThreshold <= player.playerBestOvr`. Slots whose threshold the player has not reached are present in the list but should be treated as locked.
- `isUnlocked` / `activationEnabled` are unreliable in the export (often `false` even for players clearly using the ability in-game), so do not gate on them — gate on `ovrThreshold` vs `playerBestOvr` instead.
- `isEmpty: true` slots have no `signatureAbility` populated and must be skipped.

**X-Factor (devTrait ≥ 3) vs Superstar (devTrait = 2):**
- In M26 the Zone ability is not flagged with its own field; convention is that the **highest-`ovrThreshold` unlocked slot** is the X-Factor Zone, and the rest are Superstar abilities. For devTrait=2 players, treat all unlocked slots as Superstar.
- Skip the function entirely for devTrait < 2 (Normal/Star players have no abilities to surface).

**How to apply:** when adding a new field to the franchise-processor player shape, do not trust a "wide-net try-every-name" parser to find new EA fields — probe the live Blaze response with a real persona-scoped token (the bot stores them in `ea_connections`) and inspect actual keys. The MCA export is JSON with stable field names per Madden year; guessing schemas across versions silently drops data.
