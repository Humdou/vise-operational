// Définitions des données du jeu : unités, bâtiments, améliorations, équilibrage.

export type UnitTypeId =
  | 'rifle' | 'bazooka' | 'sniper' | 'jeep' | 'tank'
  | 'artillery' | 'harvester' | 'engineer' | 'bomber' | 'scoutplane'
  | 'transportheli' | 'cargoheli'
  // Niveau 2 (Laboratoire avancé)
  | 'elite' | 'rocketeer' | 'kamikaze' | 'spy'
  | 'heavytank' | 'tankdestroyer' | 'heavyarty' | 'radarvehicle' | 'mobilecmd';

export type BuildingTypeId =
  | 'hq' | 'power' | 'refinery' | 'barracks' | 'factory' | 'airport' | 'helipad'
  | 'radar' | 'turret' | 'atgun' | 'aa' | 'tech' | 'radarcenter' | 'depot'
  // Niveau 2
  | 'lab' | 'barracks2' | 'factory2' | 'power2' | 'refinery2';

export type SpecialMapId = 'france' | 'italy';

export type UpgradeId = 'refining' | 'powerplus' | 'armor' | 'ammo' | 'optics' | 'repairs';

export type WeaponKind = 'bullet' | 'mg' | 'ap' | 'sniper' | 'shell' | 'arty' | 'bomb' | 'flak';
export type Armor = 'inf' | 'light' | 'heavy' | 'building' | 'air';
export type Difficulty = 'easy' | 'normal' | 'hard';
export type ThemeId = 'temperate' | 'snow' | 'desert' | 'mist' | 'badlands' | 'tropical';
export type MapSizeId = 'small' | 'medium' | 'large' | 'xlarge' | 'giant';

export interface WeaponDef {
  kind: WeaponKind;
  dmg: number;
  range: number;        // en tuiles
  minRange?: number;
  cooldown: number;     // secondes
  projSpeed: number;    // tuiles / s
  splash?: number;      // rayon de dégâts de zone
  indirect?: boolean;   // ignore les obstacles (artillerie, bombes)
  targetsAir: boolean;
  targetsGround: boolean;
}

export interface UnitDef {
  id: UnitTypeId;
  name: string;
  desc: string;
  cost: number;
  time: number;         // temps de production (s)
  hp: number;
  speed: number;        // tuiles / s
  vision: number;
  armor: Armor;
  radius: number;
  weapon?: WeaponDef;
  builtAt: BuildingTypeId;
  isAir?: boolean;
  transportCapacity?: number;
  transportArmor?: Armor[];
}

export interface BuildingDef {
  id: BuildingTypeId;
  name: string;
  desc: string;
  cost: number;
  time: number;         // temps de construction (s)
  hp: number;
  w: number;
  h: number;
  power: number;        // >0 produit, <0 consomme
  vision: number;
  prereq: BuildingTypeId[];
  weapon?: WeaponDef;
}

export interface UpgradeDef {
  id: UpgradeId;
  name: string;
  desc: string;
  cost: number;
  time: number;
}

// Table des multiplicateurs de dégâts : arme -> armure.
export const DMG_MULT: Record<WeaponKind, Record<Armor, number>> = {
  bullet: { inf: 1.0, light: 0.55, heavy: 0.2, building: 0.2, air: 0.3 },
  mg:     { inf: 1.2, light: 0.5, heavy: 0.15, building: 0.15, air: 0 },
  ap:     { inf: 0.35, light: 1.0, heavy: 1.0, building: 0.85, air: 0 },
  sniper: { inf: 1.0, light: 0.08, heavy: 0.04, building: 0.04, air: 0 },
  shell:  { inf: 0.55, light: 0.95, heavy: 1.0, building: 0.75, air: 0 },
  arty:   { inf: 1.0, light: 0.85, heavy: 0.65, building: 1.25, air: 0 },
  bomb:   { inf: 1.0, light: 1.0, heavy: 0.9, building: 1.1, air: 0 },
  flak:   { inf: 0, light: 0, heavy: 0, building: 0, air: 1.0 },
};

export const UNITS: Record<UnitTypeId, UnitDef> = {
  rifle: {
    id: 'rifle', name: 'Fusilier', desc: 'Infanterie de base. Bon marché, présence de terrain.',
    cost: 100, time: 4, hp: 85, speed: 1.5, vision: 5.5, armor: 'inf', radius: 0.26, builtAt: 'barracks',
    weapon: { kind: 'bullet', dmg: 9, range: 4, cooldown: 0.9, projSpeed: 16, targetsAir: false, targetsGround: true },
  },
  bazooka: {
    id: 'bazooka', name: 'Bazooka', desc: 'Infanterie antichar. Forte contre véhicules et bâtiments.',
    cost: 250, time: 6, hp: 70, speed: 1.25, vision: 5.5, armor: 'inf', radius: 0.26, builtAt: 'barracks',
    weapon: { kind: 'ap', dmg: 34, range: 4.6, cooldown: 2.1, projSpeed: 9, targetsAir: false, targetsGround: true },
  },
  sniper: {
    id: 'sniper', name: 'Sniper', desc: 'Tireur longue portée. Élimine l’infanterie.',
    cost: 300, time: 8, hp: 60, speed: 1.25, vision: 7.5, armor: 'inf', radius: 0.26, builtAt: 'barracks',
    weapon: { kind: 'sniper', dmg: 65, range: 7, cooldown: 2.6, projSpeed: 26, targetsAir: false, targetsGround: true },
  },
  engineer: {
    id: 'engineer', name: 'Ingénieur', desc: 'Répare bâtiments et véhicules. Ne combat pas.',
    cost: 250, time: 6, hp: 60, speed: 1.4, vision: 5, armor: 'inf', radius: 0.26, builtAt: 'barracks',
  },
  jeep: {
    id: 'jeep', name: 'Jeep', desc: 'Véhicule rapide : reconnaissance et harcèlement.',
    cost: 400, time: 7, hp: 220, speed: 3.4, vision: 8, armor: 'light', radius: 0.38, builtAt: 'factory',
    weapon: { kind: 'bullet', dmg: 11, range: 4.2, cooldown: 0.5, projSpeed: 16, targetsAir: false, targetsGround: true },
  },
  tank: {
    id: 'tank', name: 'Tank', desc: 'Véhicule de combat principal. Ligne de front.',
    cost: 700, time: 10, hp: 520, speed: 1.9, vision: 6, armor: 'heavy', radius: 0.44, builtAt: 'factory',
    weapon: { kind: 'shell', dmg: 48, range: 5.2, cooldown: 1.9, projSpeed: 12, splash: 0.5, targetsAir: false, targetsGround: true },
  },
  artillery: {
    id: 'artillery', name: 'Artillerie', desc: 'Siège longue portée à tir indirect. Fragile.',
    cost: 800, time: 12, hp: 180, speed: 1.2, vision: 6.5, armor: 'light', radius: 0.42, builtAt: 'factory',
    weapon: { kind: 'arty', dmg: 95, range: 10.5, minRange: 3, cooldown: 4.2, projSpeed: 7, splash: 1.4, indirect: true, targetsAir: false, targetsGround: true },
  },
  harvester: {
    id: 'harvester', name: 'Récolteur', desc: 'Récolte le minerai et le livre à la raffinerie.',
    cost: 600, time: 10, hp: 620, speed: 1.7, vision: 5, armor: 'heavy', radius: 0.46, builtAt: 'factory',
  },
  bomber: {
    id: 'bomber', name: 'Chasseur-bombardier', desc: 'Frappe aérienne rapide puis retour à l’aéroport.',
    cost: 900, time: 14, hp: 260, speed: 6.5, vision: 9, armor: 'air', radius: 0.5, builtAt: 'airport', isAir: true,
    weapon: { kind: 'bomb', dmg: 130, range: 1.6, cooldown: 0.5, projSpeed: 8, splash: 1.1, indirect: true, targetsAir: false, targetsGround: true },
  },
  scoutplane: {
    id: 'scoutplane', name: 'Avion radar', desc: 'Reconnaissance rapide non armée : révèle une large zone puis rentre.',
    cost: 350, time: 8, hp: 120, speed: 9, vision: 12, armor: 'air', radius: 0.42, builtAt: 'airport', isAir: true,
  },
  transportheli: {
    id: 'transportheli', name: 'Hélicoptère de transport', desc: 'Transport aérien de troupes. Embarque jusqu’à 6 unités d’infanterie.',
    cost: 600, time: 10, hp: 260, speed: 5.3, vision: 7.5, armor: 'air', radius: 0.5, builtAt: 'helipad', isAir: true,
    transportCapacity: 6, transportArmor: ['inf'],
  },
  cargoheli: {
    id: 'cargoheli', name: 'Hélicoptère cargo', desc: 'Transport aérien lourd. Embarque un seul véhicule terrestre.',
    cost: 700, time: 12, hp: 340, speed: 4.6, vision: 7, armor: 'air', radius: 0.58, builtAt: 'helipad', isAir: true,
    transportCapacity: 1, transportArmor: ['light', 'heavy'],
  },

  // ----- Niveau 2 : Caserne T2
  elite: {
    id: 'elite', name: 'Fusilier d’élite', desc: 'Infanterie supérieure : plus de dégâts, plus résistante.',
    cost: 250, time: 6, hp: 160, speed: 1.55, vision: 6.5, armor: 'inf', radius: 0.27, builtAt: 'barracks2',
    weapon: { kind: 'bullet', dmg: 17, range: 4.6, cooldown: 0.8, projSpeed: 17, targetsAir: false, targetsGround: true },
  },
  rocketeer: {
    id: 'rocketeer', name: 'Lance-roquettes lourd', desc: 'Antichar amélioré : portée et dégâts supérieurs.',
    cost: 480, time: 9, hp: 115, speed: 1.2, vision: 6, armor: 'inf', radius: 0.27, builtAt: 'barracks2',
    weapon: { kind: 'ap', dmg: 58, range: 6.2, cooldown: 2.4, projSpeed: 10, targetsAir: false, targetsGround: true },
  },
  kamikaze: {
    id: 'kamikaze', name: 'Kamikaze', desc: 'Rapide, explose au contact : très efficace contre groupes et bâtiments. Usage unique.',
    cost: 350, time: 7, hp: 90, speed: 3.1, vision: 5.5, armor: 'inf', radius: 0.27, builtAt: 'barracks2',
  },
  spy: {
    id: 'spy', name: 'Espion', desc: 'Infiltration et reconnaissance. Peut saboter un QG ennemi sans combattre.',
    cost: 700, time: 10, hp: 125, speed: 1.75, vision: 8, armor: 'inf', radius: 0.25, builtAt: 'barracks2',
  },

  // ----- Niveau 2 : Usine T2
  heavytank: {
    id: 'heavytank', name: 'Tank lourd', desc: 'Char de rupture à double canon : très résistant, très puissant.',
    cost: 1250, time: 15, hp: 980, speed: 1.5, vision: 6, armor: 'heavy', radius: 0.52, builtAt: 'factory2',
    weapon: { kind: 'shell', dmg: 78, range: 5.6, cooldown: 2.2, projSpeed: 12, splash: 0.7, targetsAir: false, targetsGround: true },
  },
  tankdestroyer: {
    id: 'tankdestroyer', name: 'Chasseur de chars', desc: 'Canon fixe longue portée : dévastateur contre véhicules, faible contre infanterie.',
    cost: 950, time: 12, hp: 520, speed: 1.8, vision: 7, armor: 'heavy', radius: 0.46, builtAt: 'factory2',
    weapon: { kind: 'ap', dmg: 98, range: 7.2, cooldown: 2.5, projSpeed: 16, targetsAir: false, targetsGround: true },
  },
  heavyarty: {
    id: 'heavyarty', name: 'Artillerie lourde', desc: 'Mortier de siège : portée et dégâts énormes, très lente.',
    cost: 1450, time: 17, hp: 270, speed: 0.85, vision: 7, armor: 'light', radius: 0.48, builtAt: 'factory2',
    weapon: { kind: 'arty', dmg: 165, range: 13, minRange: 4, cooldown: 5.6, projSpeed: 7, splash: 1.9, indirect: true, targetsAir: false, targetsGround: true },
  },
  radarvehicle: {
    id: 'radarvehicle', name: 'Véhicule radar', desc: 'Vision énorme : reconnaissance mobile et contrôle de carte. Non armé.',
    cost: 500, time: 8, hp: 330, speed: 2.4, vision: 13, armor: 'light', radius: 0.42, builtAt: 'factory2',
  },
  mobilecmd: {
    id: 'mobilecmd', name: 'Commandant mobile', desc: 'Camion de commandement extrêmement coûteux. Se déploie en nouveau QG.',
    cost: 6000, time: 32, hp: 1400, speed: 1.15, vision: 9, armor: 'heavy', radius: 0.56, builtAt: 'factory2',
  },
};

export const BUILDINGS: Record<BuildingTypeId, BuildingDef> = {
  hq: {
    id: 'hq', name: 'QG', desc: 'Cœur de la base. S’il tombe, vous perdez.',
    cost: 0, time: 0, hp: 3200, w: 3, h: 3, power: 40, vision: 12, prereq: [],
  },
  power: {
    id: 'power', name: 'Centrale', desc: 'Produit de l’énergie pour la base.',
    cost: 300, time: 8, hp: 600, w: 2, h: 2, power: 100, vision: 7, prereq: [],
  },
  refinery: {
    id: 'refinery', name: 'Raffinerie', desc: 'Reçoit le minerai. Livrée avec un récolteur.',
    cost: 600, time: 12, hp: 950, w: 3, h: 3, power: -30, vision: 8, prereq: ['power'],
  },
  barracks: {
    id: 'barracks', name: 'Caserne', desc: 'Produit l’infanterie.',
    cost: 300, time: 8, hp: 800, w: 2, h: 2, power: -20, vision: 7, prereq: ['power'],
  },
  factory: {
    id: 'factory', name: 'Usine', desc: 'Produit les véhicules.',
    cost: 800, time: 14, hp: 1050, w: 3, h: 3, power: -30, vision: 7, prereq: ['refinery'],
  },
  radar: {
    id: 'radar', name: 'Radar', desc: 'Révèle les ennemis sur la mini-carte, +25 % vision des bâtiments.',
    cost: 500, time: 10, hp: 600, w: 2, h: 2, power: -40, vision: 10, prereq: ['refinery'],
  },
  airport: {
    id: 'airport', name: 'Aéroport', desc: 'Produit et réarme les chasseurs-bombardiers.',
    cost: 700, time: 14, hp: 850, w: 3, h: 2, power: -40, vision: 8, prereq: ['factory', 'radar'],
  },
  helipad: {
    id: 'helipad', name: 'Héliport', desc: 'Produit des hélicoptères de transport pour projeter troupes et véhicules.',
    cost: 650, time: 12, hp: 780, w: 3, h: 2, power: -30, vision: 8, prereq: ['factory', 'radar'],
  },
  turret: {
    id: 'turret', name: 'Tourelle', desc: 'Défense anti-infanterie.',
    cost: 300, time: 6, hp: 500, w: 1, h: 1, power: -10, vision: 7, prereq: ['barracks'],
    weapon: { kind: 'mg', dmg: 14, range: 5.5, cooldown: 0.45, projSpeed: 16, targetsAir: false, targetsGround: true },
  },
  atgun: {
    id: 'atgun', name: 'Canon antichar', desc: 'Défense anti-véhicule.',
    cost: 450, time: 7, hp: 620, w: 1, h: 1, power: -10, vision: 7, prereq: ['factory'],
    weapon: { kind: 'ap', dmg: 55, range: 6, cooldown: 1.8, projSpeed: 13, targetsAir: false, targetsGround: true },
  },
  aa: {
    id: 'aa', name: 'Batterie AA', desc: 'Défense anti-aérienne.',
    cost: 400, time: 6, hp: 520, w: 1, h: 1, power: -10, vision: 9, prereq: ['barracks'],
    weapon: { kind: 'flak', dmg: 38, range: 8, cooldown: 0.8, projSpeed: 15, splash: 0.6, targetsAir: true, targetsGround: false },
  },
  tech: {
    id: 'tech', name: 'Centre tactique', desc: 'Débloque six améliorations uniques.',
    cost: 600, time: 12, hp: 720, w: 2, h: 2, power: -30, vision: 7, prereq: ['factory'],
  },
  radarcenter: {
    id: 'radarcenter', name: 'Centre radar avancé', desc: '+60 % vision des bâtiments, +15 % vision des unités.',
    cost: 800, time: 12, hp: 700, w: 2, h: 2, power: -60, vision: 12, prereq: ['radar'],
  },
  depot: {
    id: 'depot', name: 'Dépôt logistique', desc: 'Raffineries proches : +15 % de revenus, déchargement plus rapide.',
    cost: 500, time: 10, hp: 650, w: 2, h: 2, power: -15, vision: 7, prereq: ['refinery'],
  },

  // ----- Niveau 2 : le Laboratoire avancé débloque la technologie supérieure.
  lab: {
    id: 'lab', name: 'Laboratoire avancé', desc: 'Investissement majeur : débloque les bâtiments de niveau 2.',
    cost: 1500, time: 18, hp: 900, w: 3, h: 3, power: -80, vision: 8, prereq: ['factory'],
  },
  barracks2: {
    id: 'barracks2', name: 'Caserne T2', desc: 'Infanterie avancée : élite, lance-roquettes lourd, kamikaze.',
    cost: 700, time: 12, hp: 1100, w: 2, h: 2, power: -40, vision: 7, prereq: ['lab'],
  },
  factory2: {
    id: 'factory2', name: 'Usine T2', desc: 'Blindés avancés : tank lourd, chasseur de chars, artillerie lourde, véhicule radar.',
    cost: 1400, time: 16, hp: 1400, w: 3, h: 3, power: -60, vision: 7, prereq: ['lab'],
  },
  power2: {
    id: 'power2', name: 'Centrale T2', desc: 'Réacteur avancé : production d’énergie massive.',
    cost: 700, time: 12, hp: 800, w: 2, h: 2, power: 250, vision: 7, prereq: ['lab'],
  },
  refinery2: {
    id: 'refinery2', name: 'Raffinerie T2', desc: 'Raffinage supérieur : +30 % de revenus, déchargement bien plus rapide. Livrée avec un récolteur.',
    cost: 1200, time: 16, hp: 1300, w: 3, h: 3, power: -50, vision: 8, prereq: ['lab'],
  },
};

export const UPGRADES: Record<UpgradeId, UpgradeDef> = {
  refining:  { id: 'refining', name: 'Raffinage amélioré', desc: '+15 % de revenus de minerai.', cost: 500, time: 18 },
  powerplus: { id: 'powerplus', name: 'Production énergétique', desc: '+15 % d’énergie par centrale.', cost: 400, time: 15 },
  armor:     { id: 'armor', name: 'Blindage renforcé', desc: '+10 % PV des véhicules.', cost: 500, time: 18 },
  ammo:      { id: 'ammo', name: 'Munitions améliorées', desc: '+10 % de dégâts généraux.', cost: 600, time: 20 },
  optics:    { id: 'optics', name: 'Radar avancé', desc: '+25 % de portée de vision des bâtiments.', cost: 400, time: 15 },
  repairs:   { id: 'repairs', name: 'Réparations accélérées', desc: '+25 % de vitesse de réparation.', cost: 350, time: 12 },
};

export const BUILD_ORDER_UI: BuildingTypeId[] = [
  'power', 'refinery', 'depot', 'barracks', 'factory', 'radar', 'helipad',
  'radarcenter', 'airport', 'tech', 'lab', 'power2', 'refinery2', 'barracks2', 'factory2',
  'turret', 'atgun', 'aa',
];

export const MAP_SIZES: Record<MapSizeId, { name: string; tiles: number; oreScale: number; duration: string; maxPlayers: number }> = {
  small:  { name: 'Petite', tiles: 120, oreScale: 1.6, duration: '5–12 min', maxPlayers: 4 },
  medium: { name: 'Moyenne', tiles: 160, oreScale: 2.5, duration: '12–22 min', maxPlayers: 8 },
  large:  { name: 'Grande', tiles: 212, oreScale: 3.6, duration: '22–35 min', maxPlayers: 12 },
  xlarge: { name: 'Très grande', tiles: 264, oreScale: 4.8, duration: '35–50 min', maxPlayers: 16 },
  giant:  { name: 'Géante', tiles: 360, oreScale: 7.2, duration: '50–90 min', maxPlayers: 32 },
};

export const PLAYER_COUNT_CHOICES = [2, 3, 4, 8, 16, 24, 32];

export const THEMES: Record<ThemeId, {
  name: string;
  grass: string[]; rough: string[]; water: string; rock: string[];
  ore: string; oreGlow: string; shore: string; mist?: number;
}> = {
  temperate: {
    // Herbe verte vive, terre chaude brun-ocre, eau bleu marine profond,
    // roche gris-anthracite chaud. Rupture franche avec l'ancien vert olive terne.
    name: 'Plaine',
    grass: ['#3c7228', '#487e30', '#547a38', '#3e6820', '#5a8a3c', '#406230'],
    // terre accidentée : ocre-olive doux (proche de l'herbe sèche) — les
    // zones rough se FONDENT dans la prairie au lieu de trancher en orange
    rough: ['#7d6b41', '#8b784c', '#71603c', '#93814f', '#6d5e3e'],
    water: '#1e6898', rock: ['#423c34', '#524840', '#38342c', '#4e4640'],
    ore: '#d8b020', oreGlow: '#ffe84a', shore: '#cdb068',
  },
  snow: {
    // Blanc de glace pur, bleu-gris acier pour la roche, eau ardoise-bleu pâle.
    name: 'Neige',
    grass: ['#d8e4ec', '#ccdae4', '#e0eaf0', '#c8d6e2', '#d0dce8'],
    rough: ['#8c9eac', '#7e92a2', '#96a8b6', '#849ab0'],
    water: '#2a6082', rock: ['#5a6470', '#4e5a66', '#667480', '#525e6a'],
    ore: '#d0aa20', oreGlow: '#ffe060', shore: '#eaf0f6',
  },
  desert: {
    // Sable riche ocre-orangé, latérite brun-rouge, oasis turquoise vive,
    // roche brun-rouille sombre. Identité très différente du temperate.
    name: 'Désert',
    grass: ['#c8974e', '#d4a458', '#bc8e44', '#d8ac60', '#c09040'],
    rough: ['#9a5c30', '#a86838', '#8e5228', '#b07240'],
    water: '#1e8494', rock: ['#6a4030', '#7a4c38', '#5c3628', '#7e5440'],
    ore: '#cc9010', oreGlow: '#ffcc30', shore: '#e4cc80',
  },
  mist: {
    // Teintes brumeuses bleu-vert désaturées, ambiance atmosphérique.
    name: 'Brouillard léger',
    grass: ['#3a5844', '#425e4c', '#345040', '#4a6252', '#3e5a48'],
    rough: ['#4a5e52', '#425648', '#3e5246', '#50625a'],
    water: '#2a5472', rock: ['#404c4a', '#384440', '#4a5652', '#3c4844'],
    ore: '#d4b030', oreGlow: '#ffe260', shore: '#7a8872', mist: 0.30,
  },
  badlands: {
    // Terre brûlée brun-rouge scorché, roche quasi-noire, eau saumâtre bleutée.
    name: 'Terres brûlées',
    grass: ['#8c4a28', '#9a5430', '#7e4020', '#a05c38', '#843820'],
    rough: ['#4e2e18', '#5c3820', '#442814', '#583212'],
    water: '#283858', rock: ['#2a2420', '#38302a', '#22201c', '#342e28'],
    ore: '#e8b830', oreGlow: '#ffe860', shore: '#9a7e58',
  },
  tropical: {
    // Jungle vert intense saturé, sous-bois olive-jaune, lagon turquoise lumineux.
    name: 'Tropical',
    grass: ['#267830', '#2e8038', '#228428', '#348c3c', '#1e6e28', '#3a8040'],
    rough: ['#787e28', '#848a32', '#6e7824', '#8a8e3a'],
    water: '#0a7890', rock: ['#323028', '#3c3a30', '#2c2e26', '#424038'],
    ore: '#d8b428', oreGlow: '#ffee60', shore: '#e8d690',
  },
};

export const PLAYER_COLORS = [
  '#3d9be9', '#e05a4e', '#d8b643', '#9a5fd0',
  '#4fc97a', '#e08b3c', '#56cfc6', '#e36fa7',
  '#93a14e', '#6f7fe0', '#b65a38', '#7fd05a',
  '#c45f95', '#5a93d0', '#cfc25a', '#9c7050',
  // 16 couleurs supplémentaires (parties jusqu'à 32 équipes, carte Géante)
  '#46c0d8', '#d85ab0', '#7ed06a', '#d0894a',
  '#6a6fd8', '#c0d04a', '#d04a6a', '#4ad0a0',
  '#a04ad0', '#5ad0c0', '#d0b84a', '#8ad04a',
  '#d04a9a', '#4a8ad0', '#b6d04a', '#d06a4a',
];
export const PLAYER_NAMES = [
  'Joueur', 'Rouge', 'Or', 'Violet',
  'Vert', 'Orange', 'Cyan', 'Rose',
  'Olive', 'Indigo', 'Rouille', 'Lime',
  'Magenta', 'Azur', 'Sable', 'Brun',
  'Émeraude', 'Fuchsia', 'Jade', 'Cuivre',
  'Cobalt', 'Citron', 'Grenat', 'Menthe',
  'Améthyste', 'Turquoise', 'Ambre', 'Mousse',
  'Pourpre', 'Saphir', 'Tilleul', 'Brique',
];

export const START_ORE = 1000;
export const HARVEST_RATE = 35;        // minerai / s en récolte
export const HARVESTER_CAPACITY = 320;
export const UNLOAD_TIME = 1.6;
export const REPAIR_HP_PER_SEC = 16;   // auto-réparation bâtiment
export const REPAIR_ORE_PER_HP = 0.35;
export const ENGINEER_REPAIR_RATE = 32;
export const LOW_POWER_FACTOR = 0.45;  // efficacité minimale en panne d'énergie
export const BUILD_RADIUS = 9;         // distance max d'un bâtiment allié
export const FORWARD_BUILD_RADIUS = 4; // ou d'une unité alliée (expansion)
export const BOMBER_AMMO = 2;
export const BOMBER_REARM_TIME = 9;
export const SCOUT_REARM_TIME = 5;

// Minerai rare (rouge) : 15 % des gisements, valeur triple — objectif stratégique.
export const RARE_ORE_MULT = 3;
export const DEPOT_RADIUS = 8;          // portée du dépôt logistique
export const DEPOT_INCOME_BONUS = 1.15;
export const DEPOT_UNLOAD_FACTOR = 0.6; // déchargement plus rapide

// Niveau 2
export const REFINERY2_INCOME_BONUS = 1.3;  // revenus des livraisons en raffinerie T2
export const REFINERY2_UNLOAD_FACTOR = 0.5; // déchargement bien plus rapide
export const KAMIKAZE_DMG = 240;
export const KAMIKAZE_SPLASH = 2.2;
export const SPY_INFILTRATE_TIME = 2.6;
export const SPY_SABOTAGE_DURATION = 15;
export const SPY_VISION_FACTOR = 0.3;

// Secours économique des IA (anti-mort) : une IA sans aucun récolteur reçoit un
// filet de minerai très lent, plafonné — juste de quoi reconstruire une
// raffinerie/un récolteur, jamais de quoi financer une armée. Voir Game.updateEconomicRescue.
export const ECON_RESCUE_CAP = 700;       // plafond du minerai « secouru »
export const ECON_RESCUE_PER_SEC = 18;    // débit du filet (≈ 40 s pour repartir de 0)
