import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { statisticsAPI } from '../../services/api';
import { Statistics } from '../../types';

interface AnalyticsData {
  summary: {
    totalRevenue: number;
    revenueChange: number;
    totalOrders: number;
    ordersChange: number;
    activeDrivers: number;
    driversChange: number;
    activePassengers: number;
    passengersChange: number;
  };
}

interface StatisticsState {
  dashboardStats: Statistics | null;
  revenueStats: any;
  heatmapData: any;
  realtimeStats: any;
  // Analytics 頁面資料
  analyticsData: AnalyticsData | null;
  revenueTrend: any[];
  orderTrend: any[];
  orderStatus: any[];
  peakHours: any[];
  recentOrders: any[];
  driverActivity: any[];
  topDrivers: any[];
  regions: any[];
  paymentMethods: any[];
  ratings: any[];
  paymentTotal: number;
  loading: boolean;
  analyticsLoading: boolean;
  error: string | null;
}

const initialState: StatisticsState = {
  dashboardStats: null,
  revenueStats: null,
  heatmapData: null,
  realtimeStats: null,
  // Analytics 頁面資料
  analyticsData: null,
  revenueTrend: [],
  orderTrend: [],
  orderStatus: [],
  peakHours: [],
  recentOrders: [],
  driverActivity: [],
  topDrivers: [],
  regions: [],
  paymentMethods: [],
  ratings: [],
  paymentTotal: 0,
  loading: false,
  analyticsLoading: false,
  error: null,
};

export const fetchDashboardStats = createAsyncThunk(
  'statistics/fetchDashboardStats',
  async () => {
    const response = await statisticsAPI.getDashboardStats();
    if (response.success && response.data) {
      return response.data;
    }
    throw new Error(response.error || 'Failed to fetch dashboard stats');
  }
);

export const fetchRealtimeStats = createAsyncThunk(
  'statistics/fetchRealtimeStats',
  async () => {
    const response = await statisticsAPI.getRealtimeStats();
    if (response.success && response.data) {
      return response.data;
    }
    throw new Error(response.error || 'Failed to fetch realtime stats');
  }
);

// Analytics 頁面資料
export const fetchAnalyticsData = createAsyncThunk(
  'statistics/fetchAnalyticsData',
  async (days: number = 7, { rejectWithValue }) => {
    try {
      const response = await statisticsAPI.getAnalytics(days);
      console.log('[Analytics] fetchAnalyticsData response:', response);
      if (response.success && response.data) {
        return response.data;
      }
      return rejectWithValue(response.error || 'Failed to fetch analytics data');
    } catch (error: any) {
      console.error('[Analytics] fetchAnalyticsData error:', error);
      return rejectWithValue(error.message || 'Network error');
    }
  }
);

export const fetchRevenueTrend = createAsyncThunk(
  'statistics/fetchRevenueTrend',
  async (days: number = 7, { rejectWithValue }) => {
    try {
      const response = await statisticsAPI.getRevenueTrend(days);
      console.log('[Analytics] fetchRevenueTrend response:', response);
      if (response.success && response.data) {
        return response.data;
      }
      return rejectWithValue(response.error || 'Failed to fetch revenue trend');
    } catch (error: any) {
      console.error('[Analytics] fetchRevenueTrend error:', error);
      return rejectWithValue(error.message || 'Network error');
    }
  }
);

export const fetchOrderTrend = createAsyncThunk(
  'statistics/fetchOrderTrend',
  async (days: number = 7, { rejectWithValue }) => {
    try {
      const response = await statisticsAPI.getOrderTrend(days);
      console.log('[Analytics] fetchOrderTrend response:', response);
      if (response.success && response.data) {
        return response.data;
      }
      return rejectWithValue(response.error || 'Failed to fetch order trend');
    } catch (error: any) {
      console.error('[Analytics] fetchOrderTrend error:', error);
      return rejectWithValue(error.message || 'Network error');
    }
  }
);

export const fetchOrderStatus = createAsyncThunk(
  'statistics/fetchOrderStatus',
  async () => {
    const response = await statisticsAPI.getOrderStatus();
    if (response.success && response.data) {
      return response.data;
    }
    throw new Error(response.error || 'Failed to fetch order status');
  }
);

export const fetchPeakHours = createAsyncThunk(
  'statistics/fetchPeakHours',
  async () => {
    const response = await statisticsAPI.getPeakHours();
    if (response.success && response.data) {
      return response.data;
    }
    throw new Error(response.error || 'Failed to fetch peak hours');
  }
);

export const fetchRecentOrders = createAsyncThunk(
  'statistics/fetchRecentOrders',
  async (limit: number = 10) => {
    const response = await statisticsAPI.getRecentOrders(limit);
    if (response.success && response.data) {
      return response.data;
    }
    throw new Error(response.error || 'Failed to fetch recent orders');
  }
);

export const fetchDriverActivity = createAsyncThunk(
  'statistics/fetchDriverActivity',
  async () => {
    const response = await statisticsAPI.getDriverActivity();
    if (response.success && response.data) {
      return response.data;
    }
    throw new Error(response.error || 'Failed to fetch driver activity');
  }
);

export const fetchTopDrivers = createAsyncThunk(
  'statistics/fetchTopDrivers',
  async (limit: number = 10) => {
    const response = await statisticsAPI.getTopDrivers(limit);
    if (response.success && response.data) {
      return response.data;
    }
    throw new Error(response.error || 'Failed to fetch top drivers');
  }
);

export const fetchRegions = createAsyncThunk(
  'statistics/fetchRegions',
  async () => {
    const response = await statisticsAPI.getRegions();
    if (response.success && response.data) {
      return response.data;
    }
    throw new Error(response.error || 'Failed to fetch regions');
  }
);

export const fetchPaymentMethods = createAsyncThunk(
  'statistics/fetchPaymentMethods',
  async () => {
    const response = await statisticsAPI.getPaymentMethods() as any;
    if (response.success) {
      return { data: response.data, total: response.total || 0 };
    }
    throw new Error(response.error || 'Failed to fetch payment methods');
  }
);

export const fetchRatings = createAsyncThunk(
  'statistics/fetchRatings',
  async () => {
    const response = await statisticsAPI.getRatings();
    if (response.success && response.data) {
      return response.data;
    }
    throw new Error(response.error || 'Failed to fetch ratings');
  }
);

const statisticsSlice = createSlice({
  name: 'statistics',
  initialState,
  reducers: {
    clearError: (state) => {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchDashboardStats.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchDashboardStats.fulfilled, (state, action) => {
        state.loading = false;
        state.dashboardStats = action.payload;
      })
      .addCase(fetchDashboardStats.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message || 'Failed to fetch dashboard stats';
      })
      .addCase(fetchRealtimeStats.fulfilled, (state, action) => {
        state.realtimeStats = action.payload;
      })
      // Analytics 頁面資料
      .addCase(fetchAnalyticsData.pending, (state) => {
        state.analyticsLoading = true;
      })
      .addCase(fetchAnalyticsData.fulfilled, (state, action) => {
        state.analyticsLoading = false;
        state.analyticsData = action.payload;
      })
      .addCase(fetchAnalyticsData.rejected, (state, action) => {
        state.analyticsLoading = false;
        console.error('[Analytics] fetchAnalyticsData rejected:', action.payload);
      })
      .addCase(fetchRevenueTrend.fulfilled, (state, action) => {
        console.log('[Analytics] revenueTrend fulfilled:', action.payload?.length, 'items');
        state.revenueTrend = action.payload;
      })
      .addCase(fetchRevenueTrend.rejected, (state, action) => {
        console.error('[Analytics] fetchRevenueTrend rejected:', action.payload);
      })
      .addCase(fetchOrderTrend.fulfilled, (state, action) => {
        console.log('[Analytics] orderTrend fulfilled:', action.payload?.length, 'items');
        state.orderTrend = action.payload;
      })
      .addCase(fetchOrderTrend.rejected, (state, action) => {
        console.error('[Analytics] fetchOrderTrend rejected:', action.payload);
      })
      .addCase(fetchOrderStatus.fulfilled, (state, action) => {
        state.orderStatus = action.payload;
      })
      .addCase(fetchPeakHours.fulfilled, (state, action) => {
        state.peakHours = action.payload;
      })
      .addCase(fetchRecentOrders.fulfilled, (state, action) => {
        state.recentOrders = action.payload;
      })
      .addCase(fetchDriverActivity.fulfilled, (state, action) => {
        state.driverActivity = action.payload;
      })
      .addCase(fetchTopDrivers.fulfilled, (state, action) => {
        state.topDrivers = action.payload;
      })
      .addCase(fetchRegions.fulfilled, (state, action) => {
        state.regions = action.payload;
      })
      .addCase(fetchPaymentMethods.fulfilled, (state, action) => {
        state.paymentMethods = action.payload.data;
        state.paymentTotal = action.payload.total;
      })
      .addCase(fetchRatings.fulfilled, (state, action) => {
        state.ratings = action.payload;
      });
  },
});

export const { clearError } = statisticsSlice.actions;
export default statisticsSlice.reducer;