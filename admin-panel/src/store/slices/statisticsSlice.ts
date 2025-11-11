import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { statisticsAPI } from '../../services/api';
import { Statistics } from '../../types';

interface StatisticsState {
  dashboardStats: Statistics | null;
  revenueStats: any;
  heatmapData: any;
  realtimeStats: any;
  loading: boolean;
  error: string | null;
}

const initialState: StatisticsState = {
  dashboardStats: null,
  revenueStats: null,
  heatmapData: null,
  realtimeStats: null,
  loading: false,
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
      });
  },
});

export const { clearError } = statisticsSlice.actions;
export default statisticsSlice.reducer;