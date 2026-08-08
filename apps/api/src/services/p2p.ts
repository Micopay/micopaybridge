export type ProviderTier = "espora" | "maestro" | "experto" | "activo";

export interface MerchantData {
  id: string;
  stellar_address: string;
  name: string;
  type: string;
  address: string;
  lat: number;
  lng: number;
  available_mxn: number;
  max_trade_mxn: number;
  min_trade_mxn: number;
  tier: ProviderTier;
  completion_rate: number;
  trades_completed: number;
  avg_time_minutes: number;
  online: boolean;
}

const MERCHANTS_DATA: MerchantData[] = [
  {
    id: "GM001",
    stellar_address: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKUJI5KOOJ9TXWNTBBS2JN",
    name: "Farmacia Guadalupe",
    type: "farmacia",
    address: "Orizaba 45, Col. Roma Norte, CDMX",
    lat: 19.4195,
    lng: -99.1627,
    available_mxn: 5000,
    max_trade_mxn: 3000,
    min_trade_mxn: 100,
    tier: "maestro",
    completion_rate: 0.98,
    trades_completed: 312,
    avg_time_minutes: 4,
    online: true,
  },
  {
    id: "GM002",
    stellar_address: "GDAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A",
    name: "Tienda Don Pepe",
    type: "tienda",
    address: "Av. Álvaro Obregón 120, Col. Roma Norte, CDMX",
    lat: 19.4165,
    lng: -99.1580,
    available_mxn: 3000,
    max_trade_mxn: 2000,
    min_trade_mxn: 200,
    tier: "experto",
    completion_rate: 0.93,
    trades_completed: 156,
    avg_time_minutes: 7,
    online: true,
  },
  {
    id: "GM003",
    stellar_address: "GCF3CJXADZKIODEGZHTBQKPAGMO5KYVW6SLJ3J5GBQZDIFHGT7ZZQMFB",
    name: "Papelería La Central",
    type: "papeleria",
    address: "Col. Condesa, CDMX",
    lat: 19.4110,
    lng: -99.1740,
    available_mxn: 2000,
    max_trade_mxn: 1500,
    min_trade_mxn: 100,
    tier: "activo",
    completion_rate: 0.88,
    trades_completed: 45,
    avg_time_minutes: 5,
    online: true,
  },
  {
    id: "GM004",
    stellar_address: "GDTEZWGQB7V2CLS6GVKWM4B3F5QMT6BJ2UJH7D3O5XFJJJENOTK3YUD5",
    name: "Consultorio Dr. Martínez",
    type: "consultorio",
    address: "Col. Del Valle, CDMX",
    lat: 19.3960,
    lng: -99.1755,
    available_mxn: 8000,
    max_trade_mxn: 5000,
    min_trade_mxn: 500,
    tier: "espora",
    completion_rate: 0.75,
    trades_completed: 12,
    avg_time_minutes: 10,
    online: false,
  },
];

export { MERCHANTS_DATA };

export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export interface Provider {
  id: string;
  stellar_address: string;
  name: string;
  type: string;
  address: string;
  lat: number;
  lng: number;
  available_mxn: number;
  max_trade_mxn: number;
  min_trade_mxn: number;
  tier: ProviderTier;
  reputation: number;
  completion_rate: number;
  trades_completed: number;
  avg_time_minutes: number;
  online: boolean;
}

export interface MatchRequest {
  lat: number;
  lng: number;
  amount: number;
  user_address?: string;
}

export interface ScoredProvider extends Provider {
  distance_km: number;
  score: number;
}

const TIER_WEIGHTS: Record<ProviderTier, number> = {
  espora: 0.5,
  maestro: 1.0,
  experto: 0.8,
  activo: 0.65,
};

const REPUTATION_WEIGHT = 0.4;
const COMPLETION_WEIGHT = 0.35;
const DISTANCE_WEIGHT = 0.25;

function reputationFromTrades(trades: number, tier: ProviderTier): number {
  if (tier === "espora") return Math.min(0.3 + trades * 0.01, 0.5);
  if (tier === "maestro") return Math.min(0.7 + trades * 0.001, 0.95);
  return Math.min(0.6 + trades * 0.002, 0.9);
}

export function normalizeProviders(merchants: MerchantData[]): Provider[] {
  return merchants.map((m) => ({
    id: m.id,
    stellar_address: m.stellar_address,
    name: m.name,
    type: m.type,
    address: m.address,
    lat: m.lat,
    lng: m.lng,
    available_mxn: m.available_mxn,
    max_trade_mxn: m.max_trade_mxn,
    min_trade_mxn: m.min_trade_mxn,
    tier: m.tier as ProviderTier,
    reputation: reputationFromTrades(m.trades_completed, m.tier as ProviderTier),
    completion_rate: m.completion_rate,
    trades_completed: m.trades_completed,
    avg_time_minutes: m.avg_time_minutes,
    online: m.online,
  }));
}

const PROVIDERS = normalizeProviders(MERCHANTS_DATA);

export function findNearbyProviders(
  lat: number,
  lng: number,
  radiusKm: number,
  amount: number
): Provider[] {
  return PROVIDERS.filter((p) => {
    if (!p.online) return false;
    if (p.available_mxn < amount) return false;
    if (p.max_trade_mxn < amount) return false;
    if (p.min_trade_mxn > amount) return false;

    const distance = distanceKm(lat, lng, p.lat, p.lng);
    return distance <= radiusKm;
  });
}

export function scoreProvider(provider: Provider, userLat: number, userLng: number): number {
  const distance = distanceKm(userLat, userLng, provider.lat, provider.lng);
  const maxDistance = 10;
  const normalizedDistance = Math.max(0, 1 - distance / maxDistance);

  const normalizedReputation = provider.reputation;
  const normalizedCompletion = provider.completion_rate;
  const tierBonus = TIER_WEIGHTS[provider.tier];

  const score =
    REPUTATION_WEIGHT * normalizedReputation +
    COMPLETION_WEIGHT * normalizedCompletion +
    DISTANCE_WEIGHT * normalizedDistance +
    tierBonus * 0.1;

  return Math.min(Math.max(score, 0), 1);
}

export function matchUser(request: MatchRequest): ScoredProvider | null {
  const nearbyProviders = findNearbyProviders(
    request.lat,
    request.lng,
    50,
    request.amount
  );

  if (nearbyProviders.length === 0) return null;

  const scoredProviders: ScoredProvider[] = nearbyProviders.map((p) => ({
    ...p,
    distance_km: parseFloat(distanceKm(request.lat, request.lng, p.lat, p.lng).toFixed(2)),
    score: scoreProvider(p, request.lat, request.lng),
  }));

  scoredProviders.sort((a, b) => b.score - a.score);

  return scoredProviders[0];
}

export function getTopProviders(
  request: MatchRequest,
  limit: number = 5
): ScoredProvider[] {
  const nearbyProviders = findNearbyProviders(
    request.lat,
    request.lng,
    50,
    request.amount
  );

  if (nearbyProviders.length === 0) return [];

  const scoredProviders: ScoredProvider[] = nearbyProviders.map((p) => ({
    ...p,
    distance_km: parseFloat(distanceKm(request.lat, request.lng, p.lat, p.lng).toFixed(2)),
    score: scoreProvider(p, request.lat, request.lng),
  }));

  return scoredProviders
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export { PROVIDERS };
