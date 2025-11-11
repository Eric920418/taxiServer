// 管理員相關類型
export interface Admin {
  id: string;
  username: string;
  email: string;
  role: 'super_admin' | 'admin' | 'operator';
  createdAt: string;
  lastLogin: string;
}

// 司機相關類型
export interface Driver {
  driver_id: string;
  phoneNumber: string;
  licenseNumber: string;
  name: string;
  carPlate: string;
  carModel: string;
  carColor: string;
  status: 'available' | 'busy' | 'offline' | 'blocked';
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