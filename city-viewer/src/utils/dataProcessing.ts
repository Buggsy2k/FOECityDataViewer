import type { CityData, CityMapEntry, ResourceMap, Product } from '../types/citydata';

export type BuildingType = string;

export interface AggregatedResources {
  base: ResourceMap;
  motivated: ResourceMap;
  total: ResourceMap;
  guildBase: ResourceMap;
  guildMotivated: ResourceMap;
  guildTotal: ResourceMap;
}

export interface GreatBuildingInfo {
  entry: CityMapEntry;
  name: string;
  level: number;
  maxLevel: number;
  fpToNextLevel: number;
  bonusType: string;
  bonusValue: number;
  dailyProduction: ResourceMap;
  clanGoods: Array<{ good_id: string; value: number }>;
}

const RESOURCE_CATEGORIES: Record<string, string[]> = {
  'Core': ['strategy_points', 'money', 'supplies', 'medals', 'gems', 'gold'],
  'Bronze Age': ['bronze', 'stone', 'lumber', 'marble', 'dye'],
  'Iron Age': ['granite', 'honey', 'herbs', 'glass', 'brick'],
  'Early Middle Age': ['salt', 'ropes', 'dried_herbs', 'copper', 'alabaster'],
  'High Middle Age': ['silk', 'gunpowder', 'brass', 'basalt', 'talc'],
  'Late Middle Age': ['gold_ore', 'sandstone', 'porcelain', 'tar', 'wine'],
  'Colonial Age': ['coffee', 'paper', 'granite_colonial', 'whaleoil', 'cotton'],
  'Industrial Age': ['tinplate', 'rubber', 'fertilizer', 'asbestos', 'explosives', 'machineparts', 'petroleum', 'coke', 'steel', 'wire'],
  'Progressive Era': ['convenience_food', 'textiles', 'semiconductors', 'filters', 'packaging', 'lead', 'zinc'],
  'Modern/Future': ['smart_materials', 'nanowire', 'ai_data', 'paper_batteries', 'bioplastics', 'transester_gas', 'dna_data', 'nutrition_research', 'renewable_resources', 'cryptocash', 'gas', 'electromagnets', 'superconductor', 'bionics'],
  'Oceanic': ['pearls', 'artificial_scales', 'corals', 'biolight', 'plankton', 'orichalcum'],
  'Guild': ['translucent_concrete', 'papercrete', 'preservatives'],
};

export function getResourceCategory(resource: string): string {
  for (const [cat, resources] of Object.entries(RESOURCE_CATEGORIES)) {
    if (resources.includes(resource)) return cat;
  }
  return 'Other';
}

export function resolveBuildingName(cityentityId: string, data: CityData): string {
  const entity = data.CityEntities?.[cityentityId];
  if (entity?.name) return entity.name;
  // Fallback: make the ID more readable
  return cityentityId
    .replace(/^[A-Z]_/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])(\d)/g, '$1 $2');
}

export function getBuildingsByType(data: CityData): Record<BuildingType, CityMapEntry[]> {
  const groups: Record<string, CityMapEntry[]> = {};
  for (const entry of Object.values(data.CityMapData)) {
    const t = entry.type;
    if (!groups[t]) groups[t] = [];
    groups[t].push(entry);
  }
  return groups;
}

function addResources(target: ResourceMap, source: ResourceMap) {
  for (const [key, val] of Object.entries(source)) {
    target[key] = (target[key] || 0) + val;
  }
}

function extractProductResources(products: Product[]): { base: ResourceMap; motivated: ResourceMap; guildBase: ResourceMap; guildMotivated: ResourceMap } {
  const base: ResourceMap = {};
  const motivated: ResourceMap = {};
  const guildBase: ResourceMap = {};
  const guildMotivated: ResourceMap = {};

  for (const p of products) {
    if (p.type === 'resources' && p.playerResources?.resources) {
      if (p.onlyWhenMotivated) {
        addResources(motivated, p.playerResources.resources);
      } else {
        addResources(base, p.playerResources.resources);
      }
    }
    if (p.type === 'guildResources' && p.guildResources?.resources) {
      if (p.onlyWhenMotivated) {
        addResources(guildMotivated, p.guildResources.resources);
      } else {
        addResources(guildBase, p.guildResources.resources);
      }
    }
  }
  return { base, motivated, guildBase, guildMotivated };
}

export function getBuildingProduction(entry: CityMapEntry): { base: ResourceMap; motivated: ResourceMap; guildBase: ResourceMap; guildMotivated: ResourceMap } {
  const base: ResourceMap = {};
  const motivated: ResourceMap = {};
  const guildBase: ResourceMap = {};
  const guildMotivated: ResourceMap = {};

  // Production from productionOption (generic_building, etc.)
  if (entry.state.productionOption?.products) {
    const extracted = extractProductResources(entry.state.productionOption.products);
    addResources(base, extracted.base);
    addResources(motivated, extracted.motivated);
    addResources(guildBase, extracted.guildBase);
    addResources(guildMotivated, extracted.guildMotivated);
  }

  // Production from current_product (great buildings, main building)
  if (entry.state.current_product?.product?.resources) {
    addResources(base, entry.state.current_product.product.resources);
  }

  // Clan goods from great buildings
  if (entry.state.current_product?.goods) {
    for (const g of entry.state.current_product.goods) {
      base[g.good_id] = (base[g.good_id] || 0) + g.value;
    }
  }

  return { base, motivated, guildBase, guildMotivated };
}

export function aggregateProduction(data: CityData): AggregatedResources {
  const result: AggregatedResources = {
    base: {}, motivated: {}, total: {},
    guildBase: {}, guildMotivated: {}, guildTotal: {},
  };

  for (const entry of Object.values(data.CityMapData)) {
    const prod = getBuildingProduction(entry);
    addResources(result.base, prod.base);
    addResources(result.motivated, prod.motivated);
    addResources(result.guildBase, prod.guildBase);
    addResources(result.guildMotivated, prod.guildMotivated);
  }

  // Compute totals (base + motivated)
  addResources(result.total, result.base);
  addResources(result.total, result.motivated);
  addResources(result.guildTotal, result.guildBase);
  addResources(result.guildTotal, result.guildMotivated);

  return result;
}

export function getGreatBuildings(data: CityData): GreatBuildingInfo[] {
  return Object.values(data.CityMapData)
    .filter(e => e.type === 'greatbuilding')
    .map(entry => {
      const prod = getBuildingProduction(entry);
      const dailyProduction: ResourceMap = {};
      addResources(dailyProduction, prod.base);

      const clanGoods = entry.state.current_product?.goods || [];

      return {
        entry,
        name: resolveBuildingName(entry.cityentity_id, data),
        level: entry.level ?? 0,
        maxLevel: entry.max_level ?? 0,
        fpToNextLevel: entry.state.forge_points_for_level_up ?? 0,
        bonusType: entry.bonus?.type ?? 'none',
        bonusValue: entry.bonus?.value ?? 0,
        dailyProduction,
        clanGoods,
      };
    })
    .sort((a, b) => b.level - a.level);
}

const ERA_MAP: Record<string, string> = {
  StoneAge: 'Stone Age',
  BronzeAge: 'Bronze Age',
  IronAge: 'Iron Age',
  EarlyMiddleAge: 'Early Middle Age',
  HighMiddleAge: 'High Middle Age',
  LateMiddleAge: 'Late Middle Age',
  ColonialAge: 'Colonial Age',
  IndustrialAge: 'Industrial Age',
  ProgressiveEra: 'Progressive Era',
  ModernEra: 'Modern Era',
  PostModernEra: 'Postmodern Era',
  ContemporaryEra: 'Contemporary Era',
  TomorrowEra: 'Tomorrow Era',
  FutureEra: 'Future Era',
  ArcticFuture: 'Arctic Future',
  OceanicFuture: 'Oceanic Future',
  VirtualFuture: 'Virtual Future',
  SpaceAgeMars: 'Space Age Mars',
  SpaceAgeAsteroidBelt: 'Space Age Asteroid Belt',
  SpaceAgeVenus: 'Space Age Venus',
  SpaceAgeJupiterMoon: 'Space Age Jupiter Moon',
  SpaceAgeTitan: 'Space Age Titan',
  SpaceAgeSpaceHub: 'Space Age Space Hub',
  AllAge: 'All Age',
  MultiAge: 'Multi Age',
};

// Canonical era order used to map building level → era
export const ERA_ORDER: string[] = [
  'BronzeAge', 'IronAge', 'EarlyMiddleAge', 'HighMiddleAge', 'LateMiddleAge',
  'ColonialAge', 'IndustrialAge', 'ProgressiveEra', 'ModernEra', 'PostModernEra',
  'ContemporaryEra', 'TomorrowEra', 'FutureEra', 'ArcticFuture', 'OceanicFuture',
  'VirtualFuture', 'SpaceAgeMars', 'SpaceAgeAsteroidBelt', 'SpaceAgeVenus',
  'SpaceAgeJupiterMoon', 'SpaceAgeTitan', 'SpaceAgeSpaceHub',
];

// Display-name → sort rank (lower = earlier era)
export const ERA_RANK: Record<string, number> = Object.fromEntries([
  ...ERA_ORDER.map((key, i) => [ERA_MAP[key] ?? key, i]),
  ['All Age', -2],
  ['Multi Age', -1],
  ['Unknown', -3],
]);

export function extractEra(cityentityId: string, data: CityData, level?: number): string {
  const entity = data.CityEntities?.[cityentityId];

  // If there's a level and the entity has components, resolve era from components keys
  if (level != null && level > 0 && entity?.components) {
    const componentEras = ERA_ORDER.filter(e => e in entity.components!);
    if (componentEras.length > 0) {
      const idx = Math.min(level - 1, componentEras.length - 1);
      return ERA_MAP[componentEras[idx]] ?? componentEras[idx];
    }
  }

  // Fallback: try min_era
  if (entity?.requirements?.min_era) {
    return ERA_MAP[entity.requirements.min_era] ?? entity.requirements.min_era;
  }
  // Fallback: parse from ID
  const match = cityentityId.match(/^[A-Z]_([A-Za-z]+?)_/);
  if (match) {
    return ERA_MAP[match[1]] ?? match[1];
  }
  return 'Unknown';
}

export interface BuildingEraStats {
  population: number;
  happiness: number;
  forgePoints: number;
  goods: number;
  atkArmyAtk: number;
  atkArmyDef: number;
  defArmyAtk: number;
  defArmyDef: number;
}

function extractStatsFromComponent(comp: Record<string, unknown>): BuildingEraStats {
  const stats: BuildingEraStats = { population: 0, happiness: 0, forgePoints: 0, goods: 0, atkArmyAtk: 0, atkArmyDef: 0, defArmyAtk: 0, defArmyDef: 0 };

  const sr = comp.staticResources as { resources?: { resources?: { population?: number } } } | undefined;
  if (sr?.resources?.resources?.population) stats.population = sr.resources.resources.population;

  const hap = comp.happiness as { provided?: number } | undefined;
  if (hap?.provided) stats.happiness = hap.provided;

  const prod = comp.production as { options?: Array<{ products?: Array<{ playerResources?: { resources?: Record<string, number> } }> }> } | undefined;
  if (prod?.options) {
    for (const option of prod.options) {
      for (const product of option.products ?? []) {
        const res = product.playerResources?.resources;
        if (res?.strategy_points) stats.forgePoints += res.strategy_points;
        if (res?.random_good_of_age) stats.goods += res.random_good_of_age;
      }
    }
  }

  const boosts = comp.boosts as { boosts?: Array<{ type: string; value: number; targetedFeature: string }> } | undefined;
  if (boosts?.boosts) {
    for (const b of boosts.boosts) {
      if (b.targetedFeature !== 'all') continue;
      switch (b.type) {
        case 'att_boost_attacker': stats.atkArmyAtk += b.value; break;
        case 'def_boost_attacker': stats.atkArmyDef += b.value; break;
        case 'att_boost_defender': stats.defArmyAtk += b.value; break;
        case 'def_boost_defender': stats.defArmyDef += b.value; break;
      }
    }
  }

  return stats;
}

function resolveEraKey(cityentityId: string, data: CityData, level?: number): string | null {
  const entity = data.CityEntities?.[cityentityId];
  if (!entity?.components) return null;
  if (level != null && level > 0) {
    const componentEras = ERA_ORDER.filter(e => e in entity.components!);
    if (componentEras.length > 0) {
      const idx = Math.min(level - 1, componentEras.length - 1);
      return componentEras[idx];
    }
  }
  return null;
}

export function getBuildingEraStats(cityentityId: string, data: CityData, level?: number): BuildingEraStats {
  const empty: BuildingEraStats = { population: 0, happiness: 0, forgePoints: 0, goods: 0, atkArmyAtk: 0, atkArmyDef: 0, defArmyAtk: 0, defArmyDef: 0 };
  const entity = data.CityEntities?.[cityentityId];
  if (!entity?.components) return empty;
  const eraKey = resolveEraKey(cityentityId, data, level);
  if (!eraKey) return empty;
  const comp = entity.components[eraKey] as Record<string, unknown>;
  if (!comp) return empty;
  return extractStatsFromComponent(comp);
}

/** Get the current player era key (e.g. "OceanicFuture") from the Town Hall */
export function getCurrentEraKey(data: CityData): string | null {
  for (const entry of Object.values(data.CityMapData)) {
    if (entry.type === 'main_building') {
      const match = entry.cityentity_id.match(/^H_([A-Za-z]+)_Townhall$/);
      if (match) return match[1];
    }
  }
  return null;
}

/** Get stats for a building as if upgraded to the target era key */
export function getBuildingStatsAtEra(cityentityId: string, data: CityData, targetEraKey: string): BuildingEraStats | null {
  const entity = data.CityEntities?.[cityentityId];
  if (!entity?.components) return null;
  const comp = entity.components[targetEraKey] as Record<string, unknown> | undefined;
  if (!comp) return null;
  return extractStatsFromComponent(comp);
}

export function formatResourceName(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

// ——— Detailed military boosts per targetedFeature ———

export interface FeatureBoosts {
  atkArmyAtk: number;
  atkArmyDef: number;
  defArmyAtk: number;
  defArmyDef: number;
}

export const FEATURE_KEYS = ['all', 'battleground', 'guild_expedition', 'guild_raids'] as const;
export type FeatureKey = typeof FEATURE_KEYS[number];

export type MilitaryBoostSet = Record<FeatureKey, FeatureBoosts>;

function emptyFeatureBoosts(): FeatureBoosts {
  return { atkArmyAtk: 0, atkArmyDef: 0, defArmyAtk: 0, defArmyDef: 0 };
}

export function emptyMilitaryBoostSet(): MilitaryBoostSet {
  return { all: emptyFeatureBoosts(), battleground: emptyFeatureBoosts(), guild_expedition: emptyFeatureBoosts(), guild_raids: emptyFeatureBoosts() };
}

function extractMilitaryFromComponent(comp: Record<string, unknown>): MilitaryBoostSet {
  const set = emptyMilitaryBoostSet();
  const boosts = comp.boosts as { boosts?: Array<{ type: string; value: number; targetedFeature: string }> } | undefined;
  if (!boosts?.boosts) return set;
  for (const b of boosts.boosts) {
    const feat = b.targetedFeature as FeatureKey;
    if (!(feat in set)) continue;
    const fb = set[feat];
    switch (b.type) {
      case 'att_boost_attacker': fb.atkArmyAtk += b.value; break;
      case 'def_boost_attacker': fb.atkArmyDef += b.value; break;
      case 'att_boost_defender': fb.defArmyAtk += b.value; break;
      case 'def_boost_defender': fb.defArmyDef += b.value; break;
      case 'att_def_boost_attacker': fb.atkArmyAtk += b.value; fb.atkArmyDef += b.value; break;
      case 'att_def_boost_defender': fb.defArmyAtk += b.value; fb.defArmyDef += b.value; break;
      case 'att_def_boost_attacker_defender':
        fb.atkArmyAtk += b.value; fb.atkArmyDef += b.value;
        fb.defArmyAtk += b.value; fb.defArmyDef += b.value;
        break;
    }
  }
  return set;
}

export function getMilitaryBoosts(cityentityId: string, data: CityData, level?: number): MilitaryBoostSet {
  const entity = data.CityEntities?.[cityentityId];
  if (!entity?.components) return emptyMilitaryBoostSet();
  const eraKey = resolveEraKey(cityentityId, data, level);
  if (!eraKey) return emptyMilitaryBoostSet();
  const comp = entity.components[eraKey] as Record<string, unknown>;
  if (!comp) return emptyMilitaryBoostSet();
  return extractMilitaryFromComponent(comp);
}

export function getMilitaryBoostsAtEra(cityentityId: string, data: CityData, targetEraKey: string): MilitaryBoostSet | null {
  const entity = data.CityEntities?.[cityentityId];
  if (!entity?.components) return null;
  const comp = entity.components[targetEraKey] as Record<string, unknown> | undefined;
  if (!comp) return null;
  return extractMilitaryFromComponent(comp);
}

export function featureBoostTotal(fb: FeatureBoosts): { atk: number; def: number } {
  return { atk: fb.atkArmyAtk + fb.atkArmyDef, def: fb.defArmyAtk + fb.defArmyDef };
}

export function hasMilitaryBoosts(set: MilitaryBoostSet): boolean {
  return FEATURE_KEYS.some(k => {
    const fb = set[k];
    return fb.atkArmyAtk > 0 || fb.atkArmyDef > 0 || fb.defArmyAtk > 0 || fb.defArmyDef > 0;
  });
}
