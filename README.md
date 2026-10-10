# Moba GM Editor

An browser extension that adds a player and team editor to [Moba GM](https://mobagm.com/), a browser-based esports management game. It edits your local save directly, right inside the game page.

## Features

### Players tab
- Search players by nickname, name, team, country, role or roster slot.
- Edit OVR/POT, active role, contract (salary and expiry year), age, country and region.
- Edit all skills, attributes and role affinities.
- Quick bulk actions for skills: set all gameplay skills to a value, ±5, or set OVR to the average of the 12 gameplay skills.
- Hero pool editor: change mastery per hero, filter the pool, apply a value to all visible heroes, remove heroes, and add heroes with a searchable list (single or all results).
- Transfer/assign a player to any team as a starter (with role), substitute or academy player, or release him to free agents. If the slot is taken, choose whether the current occupant goes to the bench, swaps places, or is released.

### Teams tab
- Edit name, tag, logo URL, cash, sponsorship, training and academy investment, reputation and Elo.
- See the full roster (starters, substitutes, academy) with Edit and Release buttons.
- Sign a free agent shortcut that pre-selects the destination team.

### Quality of life
- Languages: Portuguese (Brazil), English and Spanish, switchable with the flags in the header. Your choice is remembered.
- **Backups:** *Export backup* downloads all players and teams as JSON. The first time you edit a player or team, the original values are stored so you can use Restore original
- Auto-reload (F5): Off by default. Toggle it in the header.
- The editor button sits next to the game's Discord button (bottom-right corner).

## Installation

Works on Chromium-based browsers that support Manifest V3: **Chrome, Edge, Brave** and similar. Firefox is not supported.

1. Download the latest ZIP from the [Releases](../../releases) page (or use **Code → Download ZIP** and use the extracted folder).
2. Extract it to a folder. Make sure `manifest.json` is **directly inside** the folder you select (not in a nested subfolder).
3. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
4. Click **Load unpacked** and select the folder.
5. Open [mobagm.com](https://mobagm.com/), load your save, and click the pencil button next to the Discord button.

### Updating
Replace the files in your folder with the new ones, click the reload icon on the extension card in `chrome://extensions`, then refresh the game tab.

## Usage tips

- Edit while the game is **not simulating**.
- Click **Export backup** before large changes.
- The game may keep data in memory. After saving, refresh the page (F5) so the game reads the new values, or enable the auto-reload option.
- Transfers apply immediately and are separate from the **Save changes** button.
- If a starter slot is left empty after a transfer or release, the editor warns you. Fill it before simulating.

## How it works

The extension is a single content script that runs on `mobagm.com`. Content scripts share the page's origin storage, so it opens the game's IndexedDB database and reads and writes records with regular transactions.

When transferring players it keeps the game's duplicated data consistent: the player record, the team's roster, substitutes and academy caches, the player's latest season record, and the stored copy of the user's team. Original values for restore are kept in `chrome.storage.local`.

## License

[MIT](LICENSE)
