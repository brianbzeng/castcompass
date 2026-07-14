export type GearCatalogKind = "rod" | "reel" | "lure";

export interface GearCatalogProduct {
  brand: string;
  series: string;
  model: string;
  label: string;
}

type CatalogSeed = Record<string, Record<string, string[]>>;

const RODS: CatalogSeed = {
  Shimano: {
    "Teramar Inshore": ["SE", "NE"],
    GLF: ["Casting", "Spinning"],
    Talavera: ["Inshore", "Boat"],
    "SpeedMaster Surf": ["Spinning", "Casting"],
    Zodias: ["Casting", "Spinning"],
    Expride: ["Casting", "Spinning"],
  },
  Daiwa: {
    "Coastal SVF": ["Casting", "Spinning"],
    "TD Sol Inshore": ["Casting", "Spinning"],
    "Saltist Inshore": ["Casting", "Spinning"],
    "Emcast Surf": ["Surf Spinning"],
    "Aird Coastal": ["Casting", "Spinning"],
  },
  PENN: {
    "Battalion II": ["Inshore Spinning", "Surf Spinning", "Surf Casting"],
    "Carnage III": ["Inshore", "Surf"],
    "Prevail II": ["Inshore", "Surf"],
    "Squadron III": ["Inshore", "Surf"],
  },
  Okuma: {
    Rockaway: ["Surf Spinning"],
    "Rockaway SP": ["Surf Spinning"],
    "PCH Custom": ["Inshore", "Casting"],
    SST: ["Spinning", "Casting"],
    "Guide Select": ["Spinning", "Casting"],
  },
  "St. Croix": {
    "Mojo Inshore": ["Spinning", "Casting"],
    "Avid Inshore": ["Spinning", "Casting"],
    "Triumph Inshore": ["Spinning"],
    "Seage Surf": ["Spinning"],
    "Legend Surf": ["Spinning"],
  },
  "Ugly Stik": {
    GX2: ["Spinning", "Casting"],
    Elite: ["Spinning", "Casting"],
    "Carbon Inshore": ["Spinning", "Casting"],
    Bigwater: ["Spinning", "Casting"],
    Tiger: ["Spinning", "Casting"],
  },
  Fenwick: {
    "HMG Inshore": ["Spinning", "Casting"],
    "Elite Inshore": ["Spinning", "Casting"],
    Eagle: ["Spinning", "Casting"],
  },
  "G. Loomis": {
    "GCX Inshore": ["Spinning", "Casting"],
    "IMX-PRO Blue": ["Spinning", "Casting"],
    "E6X Inshore": ["Spinning", "Casting"],
  },
  Phenix: {
    "M1 Inshore": ["Spinning", "Casting"],
    "Trifecta Lite": ["Spinning"],
    "Black Diamond": ["Inshore"],
    Feather: ["Spinning", "Casting"],
  },
  "Major Craft": {
    Crostage: ["Sea Bass", "Shore Jigging"],
    "Triple Cross": ["Sea Bass", "Shore Jigging"],
    Solpara: ["Sea Bass", "Shore Jigging"],
    Benkei: ["Spinning", "Casting"],
  },
  Tsunami: {
    "Trophy II Surf": ["Spinning"],
    "Airwave Elite": ["Surf Spinning"],
    "Carbon Shield II": ["Inshore Spinning", "Inshore Casting"],
  },
  Dobyns: {
    Fury: ["Spinning", "Casting"],
    Sierra: ["Spinning", "Casting"],
    "Champion XP": ["Spinning", "Casting"],
  },
  Lamiglas: {
    "Carbon Surf": ["Spinning"],
    GSB: ["Surf Spinning"],
    "Insane Surf": ["Spinning"],
  },
  TFO: {
    Professional: ["Spinning", "Casting"],
    "Tactical Inshore": ["Spinning", "Casting"],
    "GIS Inshore": ["Spinning", "Casting"],
  },
};

const REELS: CatalogSeed = {
  Shimano: {
    "Curado DC 150": ["HG", "XG"],
    "Curado DC 200": ["HG", "XG"],
    "Curado 150M": ["150M", "151M", "150HGM", "151HGM", "150XGM", "151XGM"],
    "Curado 200M": ["200M", "201M", "200HGM", "201HGM", "200XGM", "201XGM"],
    "Stradic FM": ["2500HG", "C3000HG", "4000XG", "C5000XG"],
    "Vanford A": ["2500HG", "C3000XG", "4000XG", "C5000XG"],
    "Nasci FC": ["2500HG", "C3000HG", "4000XG", "C5000XG"],
    Miravel: ["2500HG", "C3000HG", "4000XG", "C5000XG"],
    "Saragosa SW A": ["5000XG", "6000HG", "8000HG", "10000PG"],
    "Stella SW": ["5000XG", "6000HG", "8000HG", "10000PG"],
  },
  Daiwa: {
    BG: ["2500", "3000", "3500", "4000", "4500", "5000"],
    "BG MQ": ["3000D-XH", "4000D-XH", "5000D-H", "6000D-H"],
    "Saltist MQ": ["3000D-XH", "4000D-XH", "5000D-H", "6000D-H"],
    "Fuego LT": ["2500D-XH", "3000-CXH", "4000-CXH"],
    "Ballistic MQ LT": ["2500D-XH", "3000D-XH", "4000D-CXH"],
    "Coastal TW": ["80", "150"],
    "Tatula SV TW": ["100H", "100HS", "100XH"],
    Lexa: ["300H", "400H", "400PWR-P"],
  },
  PENN: {
    "Battle IV": ["2500", "3000", "4000", "5000", "6000"],
    "Spinfisher VII": ["3500", "4500", "5500", "6500"],
    "Slammer IV": ["3500", "4500", "5500", "6500"],
    "Pursuit IV": ["2500", "3000", "4000", "5000"],
    "Fierce IV": ["2500", "3000", "4000", "5000"],
    Authority: ["2500", "3500", "4500", "5500"],
    Squall: ["Low Profile 200", "Low Profile 300", "Low Profile 400"],
  },
  Okuma: {
    "Ceymar HD": ["2500A", "3000A", "4000A"],
    "Inspira ISX": ["2500", "3000", "4000"],
    "ITX CB": ["2500H", "3000H", "4000H"],
    Salina: ["4000H", "5000H", "6000H"],
    Azores: ["4000H", "6000H", "8000H"],
    Tesoro: ["5000HA", "6000HA", "8000HA"],
    "Komodo SS": ["273", "364", "471"],
  },
  "Abu Garcia": {
    "Revo SX": ["Low Profile", "Spinning 2500", "Spinning 3000"],
    "Revo X": ["Low Profile", "Spinning 2500", "Spinning 3000"],
    "Max STX": ["Low Profile", "Spinning 30", "Spinning 40"],
    Zata: ["Low Profile", "Spinning 30", "Spinning 40"],
  },
  Pflueger: {
    President: ["25", "30", "35", "40"],
    "President XT": ["25", "30", "35", "40"],
    Supreme: ["25", "30", "35", "40"],
  },
  "13 Fishing": {
    Concept: ["A2", "C2", "TX3"],
    Creed: ["GT 3000", "K 3000", "X 3000"],
  },
  "Lew's": {
    "Speed Spool": ["LFS", "Tournament MP", "Custom Pro"],
    "Mach": ["1 Spinning", "2 Spinning", "Smash Spinning"],
  },
  Quantum: {
    Smoke: ["S3 PT", "X Spinning"],
    Accurist: ["Baitcast", "Spinning"],
  },
};

const LURES: CatalogSeed = {
  "Lucky Craft": {
    FlashMinnow: ["110SP", "115MR", "130MR"],
    "Surf Pointer": ["115MR"],
    Staysee: ["90SP V2"],
  },
  Rapala: {
    "X-Rap": ["XR08", "XR10", "XR12", "XR14"],
    "X-Rap Long Cast": ["SXRLC12", "SXRLC14"],
    "Husky Jerk": ["HJ06", "HJ08", "HJ10", "HJ12", "HJ14"],
    "Shadow Rap": ["11", "Deep 11"],
  },
  "Yo-Zuri": {
    "3DB Jerkbait": ["110", "Deep 110"],
    "Hydro Minnow LC": ["150", "170"],
    "Crystal Minnow": ["110F", "130F"],
    "Pins Minnow": ["70F", "90F"],
    "Mag Dive": ["160F", "220F"],
  },
  Megabass: {
    "Vision Oneten": ["110", "110+1", "110+2"],
    "Ito Shiner": ["115SP"],
    "Hazedong Shad": ["3 in", "4.2 in", "5.2 in"],
  },
  Berkley: {
    "Gulp! Swimming Mullet": ["3 in", "4 in", "5 in", "6 in"],
    "Gulp! Jerk Shad": ["5 in", "7 in"],
    "PowerBait CullShad": ["5 in", "6 in"],
    "PowerBait The General": ["4.25 in", "5.25 in"],
  },
  "Z-Man": {
    "DieZel MinnowZ": ["4 in", "5 in", "7 in"],
    "Scented Jerk ShadZ": ["4 in", "5 in", "7 in"],
    MinnowZ: ["3 in"],
    "Swimmin TroutTrick": ["3.5 in"],
  },
  Keitech: {
    "Easy Shiner": ["3 in", "4 in", "5 in", "6.5 in"],
    "Swing Impact": ["3 in", "4 in", "4.5 in"],
    "Swing Impact FAT": ["3.8 in", "4.8 in", "5.8 in"],
  },
  Zoom: {
    "Super Fluke": ["5.25 in"],
    "Super Fluke Jr.": ["4 in"],
    Fluke: ["4 in"],
  },
  "Strike King": {
    "Rage Swimmer": ["3.25 in", "3.75 in", "4.75 in"],
    "KVD Jerkbait": ["100", "200", "300 Deep"],
  },
  Daiwa: {
    "Salt Pro Minnow": ["SPM13F", "SPM15F", "SPM17F"],
    Zakana: ["80", "100", "130"],
  },
  Shimano: {
    "World Minnow": ["115SP Flash Boost"],
    "World Diver": ["99SP Flash Boost"],
    "Coltsniper Jerkbait": ["140F", "170F"],
  },
  "Savage Gear": {
    "Sandeel Jerk Minnow": ["5 in", "7 in"],
    "Pulse Tail Mullet": ["3.5 in", "4 in", "6 in"],
    "Manic Prey": ["4 in", "6 in"],
  },
  FishLab: {
    "Bio-Shad Tail Spin": ["4 in", "5 in"],
    "Mack Attack Soft Shad": ["5 in", "7 in"],
    "Hydra Glide": ["5 in", "7 in"],
  },
  Storm: {
    "360GT Searchbait": ["3.5 in", "5.5 in"],
    "WildEye Swim Shad": ["3 in", "4 in", "5 in"],
  },
  Heddon: {
    "Super Spook Jr.": ["3.5 in"],
    "Super Spook": ["5 in"],
  },
  NLBN: {
    "Little Mullet": ["3 in", "5 in"],
    "Straight Tail": ["3 in", "5 in", "8 in"],
  },
};

const seeds: Record<GearCatalogKind, CatalogSeed> = { rod: RODS, reel: REELS, lure: LURES };

export const GEAR_CATALOG: Record<GearCatalogKind, GearCatalogProduct[]> = {
  rod: expand(RODS),
  reel: expand(REELS),
  lure: expand(LURES),
};

export function gearBrands(kind: GearCatalogKind) {
  return Object.keys(seeds[kind]);
}

export function gearProducts(kind: GearCatalogKind, brand: string) {
  return GEAR_CATALOG[kind].filter((product) => product.brand === brand);
}

export function findCatalogProduct(kind: GearCatalogKind, value: string) {
  const normalized = value.trim().toLowerCase();
  return GEAR_CATALOG[kind].find((product) => product.label.toLowerCase() === normalized) ?? null;
}

function expand(seed: CatalogSeed) {
  return Object.entries(seed).flatMap(([brand, seriesMap]) =>
    Object.entries(seriesMap).flatMap(([series, models]) =>
      models.map((model) => ({ brand, series, model, label: `${brand} ${series} ${model}` })),
    ),
  );
}
