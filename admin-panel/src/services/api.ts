import axios, { AxiosInstance } from 'axios';
import { Admin, Driver, Passenger, Order, Statistics, ApiResponse, PaginatedResponse, FilterOptions, Team } from '../types';

// 從環境變數讀取 API 基礎 URL
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api';

// 建立 axios 實例
const api: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// 請求攔截器 - 加入認證 token
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('admin_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// 回應攔截器 - 處理錯誤
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // Token 過期或無效，清除並跳轉到登入頁
      // 必須用完整路徑 /admin/login — interceptor 是普通函數無法用 useNavigate Hook，
      // 裸 /login 會繞過 React Router basename，導致伺服器回 Cannot GET /login 白屏
      localStorage.removeItem('admin_token');
      window.location.href = '/admin/login';
    }
    return Promise.reject(error);
  }
);

// 認證相關 API
export const authAPI = {
  login: async (username: string, password: string): Promise<ApiResponse<{ token: string; admin: Admin }>> => {
    const response = await api.post('/admin/auth/login', { username, password });
    return response.data;
  },

  logout: async (): Promise<void> => {
    await api.post('/admin/auth/logout');
    localStorage.removeItem('admin_token');
  },

  getProfile: async (): Promise<ApiResponse<Admin>> => {
    const response = await api.get('/admin/auth/profile');
    return response.data;
  },

  changePassword: async (oldPassword: string, newPassword: string): Promise<ApiResponse<void>> => {
    const response = await api.post('/admin/auth/change-password', { oldPassword, newPassword });
    return response.data;
  },
};

// 司機管理 API
export const driverAPI = {
  getDrivers: async (filters?: FilterOptions, page = 1, pageSize = 20): Promise<ApiResponse<PaginatedResponse<Driver>>> => {
    const response = await api.get('/admin/drivers', {
      params: { ...filters, page, pageSize }
    });
    return response.data;
  },

  getDriverById: async (driverId: string): Promise<ApiResponse<Driver>> => {
    const response = await api.get(`/admin/drivers/${driverId}`);
    return response.data;
  },

  createDriver: async (driver: Partial<Driver>): Promise<ApiResponse<Driver>> => {
    const response = await api.post('/admin/drivers', driver);
    return response.data;
  },

  updateDriver: async (driverId: string, updates: Partial<Driver>): Promise<ApiResponse<Driver>> => {
    const response = await api.put(`/admin/drivers/${driverId}`, updates);
    return response.data;
  },

  blockDriver: async (driverId: string, reason: string): Promise<ApiResponse<void>> => {
    const response = await api.post(`/admin/drivers/${driverId}/block`, { reason });
    return response.data;
  },

  unblockDriver: async (driverId: string): Promise<ApiResponse<void>> => {
    const response = await api.post(`/admin/drivers/${driverId}/unblock`);
    return response.data;
  },

  deleteDriver: async (driverId: string): Promise<ApiResponse<void>> => {
    const response = await api.delete(`/admin/drivers/${driverId}`);
    return response.data;
  },

  getDriverStatistics: async (driverId: string): Promise<ApiResponse<any>> => {
    const response = await api.get(`/admin/drivers/${driverId}/statistics`);
    return response.data;
  },
};

// 車隊（Fleet / Team）API
export const teamsAPI = {
  getTeams: async (): Promise<ApiResponse<Team[]>> => {
    const response = await api.get('/admin/teams');
    return response.data;
  },
};

// 乘客管理 API
export const passengerAPI = {
  getPassengers: async (filters?: FilterOptions, page = 1, pageSize = 20): Promise<ApiResponse<PaginatedResponse<Passenger>>> => {
    const response = await api.get('/admin/passengers', {
      params: { ...filters, page, pageSize }
    });
    return response.data;
  },

  getPassengerById: async (passengerId: string): Promise<ApiResponse<Passenger>> => {
    const response = await api.get(`/admin/passengers/${passengerId}`);
    return response.data;
  },

  updatePassenger: async (passengerId: string, updates: Partial<Passenger>): Promise<ApiResponse<Passenger>> => {
    const response = await api.put(`/admin/passengers/${passengerId}`, updates);
    return response.data;
  },

  blockPassenger: async (passengerId: string, reason: string): Promise<ApiResponse<void>> => {
    const response = await api.post(`/admin/passengers/${passengerId}/block`, { reason });
    return response.data;
  },

  unblockPassenger: async (passengerId: string): Promise<ApiResponse<void>> => {
    const response = await api.post(`/admin/passengers/${passengerId}/unblock`);
    return response.data;
  },

  getPassengerHistory: async (passengerId: string): Promise<ApiResponse<Order[]>> => {
    const response = await api.get(`/admin/passengers/${passengerId}/orders`);
    return response.data;
  },
};

// 訂單管理 API
export const orderAPI = {
  getOrders: async (filters?: FilterOptions, page = 1, pageSize = 20): Promise<ApiResponse<PaginatedResponse<Order>>> => {
    const response = await api.get('/admin/orders', {
      params: { ...filters, page, pageSize }
    });
    return response.data;
  },

  getOrderById: async (orderId: string): Promise<ApiResponse<Order>> => {
    const response = await api.get(`/admin/orders/${orderId}`);
    return response.data;
  },

  updateOrderStatus: async (orderId: string, status: string): Promise<ApiResponse<Order>> => {
    const response = await api.post(`/admin/orders/${orderId}/status`, { status });
    return response.data;
  },

  cancelOrder: async (orderId: string, reason: string): Promise<ApiResponse<void>> => {
    const response = await api.post(`/admin/orders/${orderId}/cancel`, { reason });
    return response.data;
  },

  resolveDispute: async (orderId: string, resolution: any): Promise<ApiResponse<void>> => {
    const response = await api.post(`/admin/orders/${orderId}/dispute`, resolution);
    return response.data;
  },
};

// No-Show 訂單 API（直接走 /api/orders/no-show，不需 admin 前綴）
export const noShowAPI = {
  getList: async (days = 30, limit = 100, offset = 0) => {
    const response = await api.get('/orders/no-show', {
      params: { days, limit, offset },
    });
    return response.data as {
      total: number;
      orders: Array<{
        orderId: string;
        passengerId: string;
        passengerName: string;
        passengerPhone: string;
        passengerNoShowTotal: number;
        driverId: string;
        driverName: string;
        driverPlate: string;
        pickupAddress: string;
        source: string;
        cancelledAt: string;
        cancelReason: string;
        penaltyFare: number;
      }>;
    };
  },
};

// 統計數據 API
export const statisticsAPI = {
  getDashboardStats: async (): Promise<ApiResponse<Statistics>> => {
    const response = await api.get('/admin/statistics/dashboard');
    return response.data;
  },

  getRevenueStats: async (startDate: string, endDate: string): Promise<ApiResponse<any>> => {
    const response = await api.get('/admin/statistics/revenue', {
      params: { startDate, endDate }
    });
    return response.data;
  },

  getHeatmapData: async (): Promise<ApiResponse<any>> => {
    const response = await api.get('/admin/statistics/heatmap');
    return response.data;
  },

  getRealtimeStats: async (): Promise<ApiResponse<any>> => {
    const response = await api.get('/admin/statistics/realtime');
    return response.data;
  },

  // 新增的統計 API
  getRevenueTrend: async (days: number = 7): Promise<ApiResponse<any>> => {
    const response = await api.get('/admin/statistics/revenue-trend', { params: { days } });
    return response.data;
  },

  getOrderTrend: async (days: number = 7): Promise<ApiResponse<any>> => {
    const response = await api.get('/admin/statistics/order-trend', { params: { days } });
    return response.data;
  },

  getOrderStatus: async (): Promise<ApiResponse<any>> => {
    const response = await api.get('/admin/statistics/order-status');
    return response.data;
  },

  getPeakHours: async (): Promise<ApiResponse<any>> => {
    const response = await api.get('/admin/statistics/peak-hours');
    return response.data;
  },

  getRecentOrders: async (limit: number = 10): Promise<ApiResponse<any>> => {
    const response = await api.get('/admin/statistics/recent-orders', { params: { limit } });
    return response.data;
  },

  getDriverActivity: async (): Promise<ApiResponse<any>> => {
    const response = await api.get('/admin/statistics/driver-activity');
    return response.data;
  },

  getTopDrivers: async (limit: number = 10): Promise<ApiResponse<any>> => {
    const response = await api.get('/admin/statistics/top-drivers', { params: { limit } });
    return response.data;
  },

  getRegions: async (): Promise<ApiResponse<any>> => {
    const response = await api.get('/admin/statistics/regions');
    return response.data;
  },

  getPaymentMethods: async (): Promise<ApiResponse<any>> => {
    const response = await api.get('/admin/statistics/payment-methods');
    return response.data;
  },

  getRatings: async (): Promise<ApiResponse<any>> => {
    const response = await api.get('/admin/statistics/ratings');
    return response.data;
  },

  getAnalytics: async (days: number = 7): Promise<ApiResponse<any>> => {
    const response = await api.get('/admin/statistics/analytics', { params: { days } });
    return response.data;
  },
};

// 管理員管理 API
export const adminAPI = {
  getAdmins: async (): Promise<ApiResponse<Admin[]>> => {
    const response = await api.get('/admin/users');
    return response.data;
  },

  createAdmin: async (admin: Partial<Admin> & { password: string }): Promise<ApiResponse<Admin>> => {
    const response = await api.post('/admin/users', admin);
    return response.data;
  },

  updateAdmin: async (adminId: string, updates: Partial<Admin>): Promise<ApiResponse<Admin>> => {
    const response = await api.put(`/admin/users/${adminId}`, updates);
    return response.data;
  },

  deleteAdmin: async (adminId: string): Promise<ApiResponse<void>> => {
    const response = await api.delete(`/admin/users/${adminId}`);
    return response.data;
  },
};

// 通知 API 回應類型
interface NotificationResponse {
  success: boolean;
  data: any[];
  unreadCount: number;
  error?: string;
}

// 通知 API
export const notificationAPI = {
  getNotifications: async (category?: string, unreadOnly?: boolean, limit?: number): Promise<NotificationResponse> => {
    const response = await api.get('/admin/notifications', {
      params: { category, unreadOnly, limit }
    });
    return response.data;
  },

  markAsRead: async (id: string): Promise<ApiResponse<void>> => {
    const response = await api.post(`/admin/notifications/${id}/read`);
    return response.data;
  },

  markAllAsRead: async (): Promise<ApiResponse<void>> => {
    const response = await api.post('/admin/notifications/read-all');
    return response.data;
  },

  deleteNotification: async (id: string): Promise<ApiResponse<void>> => {
    const response = await api.delete(`/admin/notifications/${id}`);
    return response.data;
  },

  clearAll: async (): Promise<ApiResponse<void>> => {
    const response = await api.delete('/admin/notifications');
    return response.data;
  },

  createNotification: async (data: {
    type: string;
    category: string;
    title: string;
    message: string;
    relatedId?: string;
    link?: string;
  }): Promise<ApiResponse<any>> => {
    const response = await api.post('/admin/notifications', data);
    return response.data;
  },
};

// 電話記錄 API
export const phoneCallAPI = {
  list: (params: { page?: number; pageSize?: number; status?: string }) => {
    const { page = 1, pageSize = 20, status } = params;
    return api.get('/phone-calls', {
      params: {
        limit: pageSize,
        offset: (page - 1) * pageSize,
        ...(status ? { status } : {}),
      },
    });
  },
  getNeedsReview: () => api.get('/phone-calls/needs-review'),
  getNeedsReviewCount: () => api.get('/phone-calls/needs-review/count'),
  reviewCall: (callId: string, data: {
    action: 'APPROVED' | 'REJECTED';
    editedFields?: Record<string, any>;
    note?: string;
  }) => api.post(`/phone-calls/${callId}/review`, data),
};

// ============================================================
// 地標管理 API（Phase 1.5：Landmarks 頁面使用）
// ============================================================
export interface Landmark {
  id: number;
  name: string;
  lat: number | string;
  lng: number | string;
  address: string;
  category: 'TRANSPORT' | 'MEDICAL' | 'SCHOOL' | 'COMMERCIAL' |
            'GOVERNMENT' | 'ATTRACTION' | 'HOTEL' | 'TOWNSHIP';
  district: string;
  priority: number;
  dropoff_lat: number | string | null;
  dropoff_lng: number | string | null;
  dropoff_address: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  alias_count?: number;
  aliases?: Array<{ id: number; alias: string; type: 'ALIAS' | 'TAIGI' }>;
}

export interface LandmarkInput {
  name: string;
  lat: number;
  lng: number;
  address: string;
  category: string;
  district: string;
  priority: number;
  dropoff_lat?: number | null;
  dropoff_lng?: number | null;
  dropoff_address?: string | null;
  aliases: string[];
  taigi_aliases: string[];
}

export interface LandmarkAudit {
  id: number;
  landmark_id: number;
  admin_id: string;
  admin_username: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'RESTORE';
  before_data: any;
  after_data: any;
  created_at: string;
}

// 從 Server 取得 Google Maps API Key（已登入管理員才會回）
// Key 載入後快取在 module level，避免每次開 Modal 都打 API
let cachedGmapsKey: string | null = null;
export async function getGoogleMapsKey(): Promise<string> {
  if (cachedGmapsKey) return cachedGmapsKey;
  const res = await api.get('/admin/landmarks/config/gmaps-key');
  if (!res.data.success || !res.data.api_key) {
    throw new Error(res.data.error || 'Server 未回傳 Google Maps Key');
  }
  cachedGmapsKey = res.data.api_key;
  return cachedGmapsKey!;
}

export const landmarkAPI = {
  list: (params: {
    q?: string;
    category?: string;
    district?: string;
    include_deleted?: boolean;
    page?: number;
    page_size?: number;
  }) => api.get('/admin/landmarks', { params }),

  get: (id: number) => api.get(`/admin/landmarks/${id}`),

  audit: (id: number) => api.get(`/admin/landmarks/${id}/audit`),

  create: (data: LandmarkInput) => api.post('/admin/landmarks', data),

  update: (id: number, data: Partial<LandmarkInput>) =>
    api.patch(`/admin/landmarks/${id}`, data),

  remove: (id: number) => api.delete(`/admin/landmarks/${id}`),

  hardRemove: (id: number) => api.delete(`/admin/landmarks/${id}/hard`),

  restore: (id: number) => api.post(`/admin/landmarks/${id}/restore`),

  rebuildIndex: () => api.post('/admin/landmarks/rebuild-index'),
};

// 待補齊地標 API（Phase 2.2）
export interface AddressLookupFailure {
  id: number;
  query: string;
  normalized: string;
  source: 'LINE' | 'PHONE' | 'APP_VOICE';
  best_match: any;
  google_result: any;
  final_coords: any;
  hit_count: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_landmark_id: number | null;
  resolved_at: string | null;
}

export const addressFailureAPI = {
  list: (params: { source?: string; resolved?: boolean; page?: number; page_size?: number }) =>
    api.get('/admin/address-failures', { params }),
  markResolved: (id: number, landmarkId: number) =>
    api.post(`/admin/address-failures/${id}/resolve`, { landmark_id: landmarkId }),
  dismiss: (id: number) => api.delete(`/admin/address-failures/${id}`),
};

export default api;