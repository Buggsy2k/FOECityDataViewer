// Types matching the citydata.json structure

export interface ResourceMap {
  [resource: string]: number;
}

export interface ProductResources {
  resources: ResourceMap;
}

export interface RandomDrop {
  product: Product;
  dropChance: number;
}

export interface Product {
  type: "resources" | "genericReward" | "guildResources" | "unit" | "random";
  flags: string[];
  onlyWhenMotivated?: boolean;
  isRandom?: boolean;
  playerResources?: ProductResources;
  guildResources?: ProductResources;
  reward?: GenericReward;
  /** random type: array of weighted drops */
  products?: RandomDrop[];
  /** unit type (guild raids) */
  unitTypeId?: string;
  amount?: number;
  requirements?: { resources: ResourceMap };
}

export interface UnitInfo {
  abilities: Array<{
    type: string;
    name: string;
    description?: string;
    icon: string;
    value?: number;
    terrains?: string[];
  }>;
  bonuses: unknown[];
  unitTypeId: string;
}

export interface GenericReward {
  type: string;
  subType: string;
  amount: number;
  id: string;
  name: string;
  description?: string;
  iconAssetName?: string;
  isHighlighted?: boolean;
  flags: string[];
  boostValue?: number;
  assembledReward?: GenericReward;
  requiredAmount?: number;
  duration?: number;
  value?: number;
  /** Present when type === 'unit' (resolved reward) */
  unit?: UnitInfo;
  /** Present on chest-type rewards with random unit drops */
  possible_rewards?: Array<{ drop_chance: number; reward: GenericReward }>;
}

export interface ProductionOption {
  asset: string;
  name: string;
  time: number;
  products: Product[];
}

export interface CurrentProduct {
  name: string;
  production_time: number;
  asset_name: string;
  product?: ProductResources;
  goods?: Array<{ good_id: string; value: number }>;
  amount?: number;
  requirements?: { cost?: { resources: ResourceMap | unknown[] } };
}

export interface BuildingState {
  next_state_transition_in?: number;
  next_state_transition_at?: number;
  forge_points_for_level_up?: number;
  current_product?: CurrentProduct;
  productionOption?: ProductionOption;
  socialInteractionStartedAt?: number;
  socialInteractionId?: string;
  invested_forge_points?: number;
}

export interface BuildingBonus {
  value: number;
  type: string;
  amount?: number;
  bonusCategory?: { value: string };
  targetedFeature?: string;
}

export interface UnitSlot {
  entity_id: number;
  nr?: number;
  unit_id: number;
  unlockCosts?: { resources: ResourceMap | unknown[] };
  unlocked?: boolean;
  is_unlockable?: boolean;
}

export interface CityMapEntry {
  id: number;
  player_id: number;
  cityentity_id: string;
  type: string;
  x: number;
  y: number;
  connected?: number;
  state: BuildingState;
  level?: number;
  max_level?: number;
  bonus?: BuildingBonus;
  bonuses: unknown[];
  decayedFromCityEntityId?: string;
  decaysAt?: number;
  unitSlots?: UnitSlot[];
}

export interface UnlockedArea {
  x: number;
  y: number;
  width: number;
  length: number;
}

export interface CityEntityRequirements {
  cost?: { resources: ResourceMap };
  tech_id?: string;
  min_era?: string;
  street_connection_level?: number;
}

export interface AvailableProduct {
  name: string;
  production_time: number;
  asset_name: string;
  production_option: number;
  requirements?: { cost?: { resources: ResourceMap } };
  unit_type_id: string;
  unit_class: string;
  amount: number;
  time_to_heal: number;
  time_to_train: number;
}

export interface CityEntity {
  id: string;
  asset_id: string;
  name: string;
  type: string;
  width: number;
  length: number;
  requirements?: CityEntityRequirements;
  construction_time?: number;
  provided_happiness?: number;
  entity_levels: unknown[];
  abilities?: unknown[];
  components?: Record<string, unknown>;
  available_products?: AvailableProduct[];
  usable_slots?: number;
  is_special?: boolean;
}

export interface CityData {
  CityMapData: Record<string, CityMapEntry>;
  UnlockedAreas: UnlockedArea[];
  CityEntities: Record<string, CityEntity>;
}
