# 📣 Bot Update — What's New

Hey league, big round of changes just shipped to the bot. Quick rundown so everyone knows what's there and how to find it.

---

## 🆕 New Features

**🎙️ Press Conference**
Hold a press conference each week — either **Trash Talk an opponent** (your scheduled matchup) or do a **General Interview** about your team. You'll get 2–3 random questions to answer in a modal. Posts your answers to the channel, opponent can reply on trash-talk sessions.

**⚔️ Rivalries**
View your top 4 head-to-head rivals — series record, average margin, and a "temperature" rating from ❄️ Cold up to 🔥 Inferno. Rivalries are calculated from **all your historical H2H games** (we just backfilled 75 old games that weren't linked, so a bunch of you will see rivals show up now). You need **3+ all-time games** vs the same opponent for them to qualify.

**🏋️ Hire Positional Trainer**
Hire a personal trainer for a **specific player** on your roster. Each week the bot rolls random attribute boosts on that player. Choose Gold / Silver / Bronze tier, pick the player by position, pick a focus area, and pick how many weeks.

- 🥇 Gold — higher hit rate, can roll up to 2 boosts per hit
- 🥈 Silver — middle tier, 1 boost per hit
- 🥉 Bronze — entry tier, 1 boost per hit
- Cooldown after each successful roll (2 weeks reduced chance)
- Caps respected per player per season (Speed +3, Strength/COD/Accel/Agility +4, 99 OVR cap)
- **2 trainer hires max per user per season**

**📋 My Trainers**
See your active trainers, weeks remaining, and recent roll history.

---

## 💰 Payout Changes

- **Rivalry win bonus**: When you beat someone who's in your personal top-4 rivals (and vice-versa), each side earns **+20 coins** on top of the normal win payout.
- **Press Conference**: pays coins per session (trash talk and general both earn — exact amounts configurable by commish).
- **GOTW vote**: voters who pick the winning team are paid **25 coins** per correct vote. This applies to **every playoff matchup**, not just the regular-season Game of the Week.
- All existing payouts (weekly wins, milestones, end-of-season stat tiers, wagers, etc.) are unchanged.

---

## 🗺️ Menu Layout (`/menu`)

Everything lives in one place now — open `/menu` and pick a category:

- **👔 Coaches Office** — Rosters & Schedule, 🎙️ Press Conference, ⚔️ Rivalries, 🏋️ Hire Trainer, 📋 My Trainers, Training Packages, Age Resets, Dev Ups
- **💼 GM's Office** — 🪙 Bank, 💵 Payouts, 📋 Contract Extensions, 💵 Salary Reductions, 🎁 Bonus Reductions, 🏆 Legends, 🎨 Custom Players
- **⚔️ Wagers** — set up and resolve coin wagers
- **🏆 GOTW Vote** — vote on the Game of the Week (and every playoff matchup). Replaces the old Discord poll
- **🎮 GOTY Vote** — appears at end of regular season for Game of the Year voting
- **📊 Standings & Stats** — League standings, any user's stats, Season / All-Time / Global Power Rankings
- **📜 League Info** — Rules, help, league basics

---

## 🔧 Fixes Included in This Drop

- Press Conference button no longer dumps you into the old interview menu
- Hire Positional Trainer no longer errors out when you click it
- Startup data cleanup for older inventory records
- Backfilled 75 historical games with their opponent links so rivalries reflect real history

---

If anything's broken or unclear, ping a commish. GLHF.
