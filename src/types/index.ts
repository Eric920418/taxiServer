/**
 * 類型定義檔案
 */

export interface Location {
  lat: number;
  lng: number;
}

export interface Driver {
  driverId: string;
  name: string;
  phone: string;
  plate: string;
  availability: 'OFFLINE' | 'REST' | 'AVAILABLE' | 'ON_TRIP';
  currentLat: number;
  currentLng: number;
  lastHeartbeat: Date;
  totalTrips: number;
  totalEarnings: number;
  rating: number;
  acceptanceRate: number;
  cancelRate: number;
}

export interface Order {
  orderId: string;
  passengerId: string;
  driverId?: string;
  status: 'PENDING' | 'OFFERED' | 'ACCEPTED' | 'ARRIVED' | 'ON_TRIP' | 'DONE' | 'CANCELLED';
  pickupLat: number;
  pickupLng: number;
  pickupAddress: string;
  destLat: number;
  destLng: number;
  destAddress: string;
  paymentType: 'CASH' | 'CARD' | 'LINE_PAY';
  estimatedAmount?: number;
  meterAmount?: number;
  estimatedDistanceKm?: number;
  actualDistanceKm?: number;
  estimatedDurationMin?: number;
  actualDurationMin?: number;
  createdAt: Date;
  offeredAt?: Date;
  acceptedAt?: Date;
  arrivedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  cancelledBy?: string;
  cancelReason?: string;
  hourOfDay?: number;
  dayOfWeek?: number;
}

export interface Passenger {
  passengerId: string;
  phone: string;
  name?: string;
  totalRides: number;
  totalSpent: number;
  rating: number;
}