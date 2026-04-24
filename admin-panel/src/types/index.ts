// 管理員相關類型
export interface Admin {
  id: string;
  username: string;
  email: string;
  role: 'super_admin' | 'admin' | 'operator';
  createdAt: string;
  lastLogin: string;
}

// 車隊（Fleet / Team）
export interface Team {
  teamId: number;
  name: string;
  note?: string | null;
  isActive: boolean;
}

// 司機相關類型
export interface Driver {
  driver_id: string;
  phoneNumber: string;
  licenseNumber?: string;
  name: string;
  carPlate: string;
  carModel: string;
  carColor: string;
  // runtime 狀態（司機 App 自己控制）
  status: 'AVAILABLE' | 'REST' | 'ON_TRIP' | 'OFFLINE' | 'available' | 'busy' | 'offline' | 'blocked';
  // 管理員設定的帳號狀態
  accountStatus?: 'ACTIVE' | 'SUSPENDED' | 'PENDING' | 'ARCHIVED';
  driverType?: 'HIGH_VOLUME' | 'REGULAR' | 'PART_TIME' | 'CONTRACT';
  teamId?: number | null;
  teamName?: string | null;
  acceptedOrderTypes?: string[];
  acceptedRebateLevels?: number[];
  note?: string | null;
  isBlocked: boolean;
  blockReason?: string;
  rating: number;
  totalTrips: number;
  totalEarnings: number;
  location?: {
    latitude: number;
    longitude: number;
    lastUpdated: string;
  };
  createdAt: string;
  lastActive: string;
  documents?: {
    license?: string;
    insurance?: string;
    registration?: string;
  };
}

// 乘客相關類型
export interface Passenger {
  passenger_id: string;
  phoneNumber: string;
  name: string;
  email?: string;
  status: 'active' | 'blocked';
  isBlocked: boolean;
  blockReason?: string;
  totalTrips: number;
  totalSpent: number;
  rating: number;
  createdAt: string;
  lastActive: string;
}

// 訂單相關類型
export interface Order {
  order_id: string;
  passenger_id: string;
  driver_id?: string;
  status: 'pending' | 'accepted' | 'arrived' | 'picked_up' | 'completed' | 'cancelled';
  pickupLocation: {
    address: string;
    latitude: number;
    longitude: number;
  };
  dropoffLocation: {
    address: string;
    latitude: number;
    longitude: number;
  };
  fare: number;
  distance: number;
  duration: number;
  paymentMethod: 'cash' | 'card' | 'wallet';
  paymentStatus: 'pending' | 'completed' | 'failed';
  createdAt: string;
  acceptedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  cancelReason?: string;
  rating?: number;
  feedback?: string;
  // === 2026-04 擴充：付款方式 / 補貼 / 備註 / no-show 罰金 ===
  paymentType?: string;          // 後端原始欄位 CASH / LOVE_CARD_PHYSICAL / OTHER
  subsidyType?: string;          // NONE / SENIOR_CARD / LOVE_CARD / PENDING
  subsidyConfirmed?: boolean;    // 司機是否已確認補貼卡
  notes?: string;                // 客人備註（LIFF 叫車時填寫）
  penaltyFare?: number;          // no-show 罰金（元）
  source?: string;               // 叫車來源：APP / LINE / PHONE
}

// 統計數據類型
export interface Statistics {
  totalDrivers: number;
  activeDrivers: number;
  totalPassengers: number;
  activePassengers: number;
  totalOrders: number;
  completedOrders: number;
  totalRevenue: number;
  todayRevenue: number;
  averageRating: number;
  peakHours: Array<{
    hour: number;
    orders: number;
  }>;
}

// API 回應類型
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// 分頁類型
export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PaginatedResponse<T> {
  items: T[];
  pagination: Pagination;
}

// 篩選器類型
export interface FilterOptions {
  search?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}