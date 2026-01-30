import axios, { AxiosInstance } from 'axios';
import { Admin, Driver, Passenger, Order, Statistics, ApiResponse, PaginatedResponse, FilterOptions } from '../types';

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
      localStorage.removeItem('admin_token');
      window.location.href = '/login';
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

export default api;