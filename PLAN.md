# FOE City Data Viewer — App Plan

## Overview
A **React (Vite + TypeScript)** single-page app that loads a `citydata.json` export from Forge of Empires via drag-and-drop, then provides four interactive views to explore the city data.

## Data Structure (citydata.json)
The file contains 3 top-level keys:

| Key | Description |
|-----|-------------|
| **CityMapData** | ~2,000+ placed building entries keyed by ID. Each has type, position (x,y), level, production state, bonuses |
| **UnlockedAreas** | Array of grid zones defining the playable area (x, y, width, length) |
| **CityEntities** | ~500+ building template definitions with era-specific metadata, costs, and production tiers |

### Building Types
`main_building`, `generic_building`, `greatbuilding`, `street`, `tower`, `hub_main`, `military`, `friends_tavern`, `outpost_ship`, `off_grid`, `culture`

### Resources (40+ types)
- **Core**: money, supplies, medals, strategy_points (Forge Points)
- **Premium**: gems, gold
- **Era Goods**: bronze, marble, granite, herbs, honey, glass, salt, ropes, brick, wire, paper, coke, steel, rubber, etc.
- **Advanced Goods**: smart_materials, nanowire, ai_data, paper_batteries, bioplastics, transester_gas, etc.
- **Oceanic**: pearls, artificial_scales, corals, biolight, plankton
- **Guild**: translucent_concrete, papercrete, preservatives, silks, gunpowder, brass, basalt, talc

### Production System
- 24-hour production cycles (86,400 seconds)
- Motivation bonuses (`onlyWhenMotivated` flag)
- Random rewards (fragments, consumables)
- Guild resource production
- Great Building clan goods production

---

## Phase 1: Project Setup

1. **Scaffold Vite + React + TS** — `city-viewer/` in the workspace
2. **Dependencies**: `@tanstack/react-table` (sortable/filterable table)
3. **TypeScript types** (`src/types/citydata.ts`) — interfaces derived from the JSON structure
4. **DataLoader component** — drag-and-drop zone + file picker; parse & validate JSON; store in React Context

## Phase 2: Data Processing Layer

5. **`src/utils/dataProcessing.ts`** — aggregate daily resource totals, group by building type, separate base vs. motivated production, resolve building names from CityEntities, categorize resources
6. **`src/utils/gridUtils.ts`** — compute grid bounds from UnlockedAreas, map building footprints

## Phase 3: UI Views

### 3A: Production Summary (`ProductionSummary.tsx`)
- Card dashboard of total daily output per resource
- Grouped by category: FP, coins, supplies, medals, era goods, guild goods
- Base vs. motivated totals

### 3B: Building Table (`BuildingTable.tsx`)
- `@tanstack/react-table`-powered sortable/filterable table
- Columns: Name, Type, Level, Position, Connected, Production summary, Motivation status
- Row expansion for full production details
- Type and resource filters

### 3C: City Grid Map (`CityGrid.tsx`)
- SVG-based 2D top-down grid
- Color-coded by building type (GB=gold, generic=blue, street=gray, military=red, culture=green)
- Hover tooltips, click for detail
- Pan & zoom

### 3D: Great Buildings Tracker (`GreatBuildings.tsx`)
- Cards showing name, level, bonus type+value, daily production, FP to next level
- Sortable by FP cost or level

## Phase 4: App Shell
- Tab navigation between 4 views
- Landing screen = DataLoader
- Header with player summary stats (total buildings, total FP/day)

## Phase 5: Polish
- Dark theme (game-appropriate)
- Responsive layout
- Loading states for large JSON parsing

## Technical Decisions
- **Purely client-side** — no backend, all processing in-browser
- **SVG** for grid map (easier interactivity, ~2000 buildings is manageable)
- **CityEntities lookup** for building names with raw ID as fallback
- **Dark theme** by default
- **Scope excluded**: no data editing, no multi-file comparison, no server — read-only viewer only

## File Structure
```
city-viewer/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── App.css
│   ├── types/
│   │   └── citydata.ts
│   ├── context/
│   │   └── CityDataContext.tsx
│   ├── utils/
│   │   ├── dataProcessing.ts
│   │   └── gridUtils.ts
│   └── components/
│       ├── DataLoader.tsx
│       ├── ProductionSummary.tsx
│       ├── BuildingTable.tsx
│       ├── CityGrid.tsx
│       └── GreatBuildings.tsx
```
