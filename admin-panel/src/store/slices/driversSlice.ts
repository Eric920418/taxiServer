import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { driverAPI } from '../../services/api';
import { Driver, FilterOptions, PaginatedResponse } from '../../types';

interface DriversState {
  drivers: Driver[];
  selectedDriver: Driver | null;
  loading: boolean;
  error: string | null;
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  filters: FilterOptions;
}

const initialState: DriversState = {
  drivers: [],
  selectedDriver: null,
  loading: false,
  error: null,
  pagination: {
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 0,
  },
  filters: {},
};

// 非同步 thunk actions
export const fetchDrivers = createAsyncThunk(
  'drivers/fetchDrivers',
  async ({ filters, page, pageSize }: { filters?: FilterOptions; page?: number; pageSize?: number }) => {
    const response = await driverAPI.getDrivers(filters, page, pageSize);
    if (response.success && response.data) {
      return response.data;
    }
    throw new Error(response.error || 'Failed to fetch drivers');
  }
);

export const fetchDriverById = createAsyncThunk(
  'drivers/fetchDriverById',
  async (driverId: string) => {
    const response = await driverAPI.getDriverById(driverId);
    if (response.success && response.data) {
      return response.data;
    }
    throw new Error(response.error || 'Failed to fetch driver');
  }
);

export const createDriver = createAsyncThunk(
  'drivers/createDriver',
  async (driver: Partial<Driver>) => {
    const response = await driverAPI.createDriver(driver);
    if (response.success && response.data) {
      return response.data;
    }
    throw new Error(response.error || 'Failed to create driver');
  }
);

export const updateDriver = createAsyncThunk(
  'drivers/updateDriver',
  async ({ driverId, updates }: { driverId: string; updates: Partial<Driver> }) => {
    const response = await driverAPI.updateDriver(driverId, updates);
    if (response.success && response.data) {
      return response.data;
    }
    throw new Error(response.error || 'Failed to update driver');
  }
);

export const blockDriver = createAsyncThunk(
  'drivers/blockDriver',
  async ({ driverId, reason }: { driverId: string; reason: string }) => {
    const response = await driverAPI.blockDriver(driverId, reason);
    if (response.success) {
      return { driverId, blocked: true, reason };
    }
    throw new Error(response.error || 'Failed to block driver');
  }
);

export const unblockDriver = createAsyncThunk(
  'drivers/unblockDriver',
  async (driverId: string) => {
    const response = await driverAPI.unblockDriver(driverId);
    if (response.success) {
      return { driverId, blocked: false };
    }
    throw new Error(response.error || 'Failed to unblock driver');
  }
);

const driversSlice = createSlice({
  name: 'drivers',
  initialState,
  reducers: {
    setFilters: (state, action: PayloadAction<FilterOptions>) => {
      state.filters = action.payload;
    },
    clearFilters: (state) => {
      state.filters = {};
    },
    clearError: (state) => {
      state.error = null;
    },
    clearSelectedDriver: (state) => {
      state.selectedDriver = null;
    },
  },
  extraReducers: (builder) => {
    // Fetch drivers
    builder
      .addCase(fetchDrivers.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchDrivers.fulfilled, (state, action) => {
        state.loading = false;
        state.drivers = action.payload.items;
        state.pagination = action.payload.pagination;
        state.error = null;
      })
      .addCase(fetchDrivers.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message || 'Failed to fetch drivers';
      });

    // Fetch driver by ID
    builder
      .addCase(fetchDriverById.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchDriverById.fulfilled, (state, action) => {
        state.loading = false;
        state.selectedDriver = action.payload;
        state.error = null;
      })
      .addCase(fetchDriverById.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message || 'Failed to fetch driver';
      });

    // Create driver
    builder
      .addCase(createDriver.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(createDriver.fulfilled, (state, action) => {
        state.loading = false;
        state.drivers.push(action.payload);
        state.error = null;
      })
      .addCase(createDriver.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message || 'Failed to create driver';
      });

    // Update driver
    builder
      .addCase(updateDriver.fulfilled, (state, action) => {
        const index = state.drivers.findIndex(d => d.driver_id === action.payload.driver_id);
        if (index !== -1) {
          state.drivers[index] = action.payload;
        }
        if (state.selectedDriver?.driver_id === action.payload.driver_id) {
          state.selectedDriver = action.payload;
        }
      });

    // Block driver
    builder
      .addCase(blockDriver.fulfilled, (state, action) => {
        const driver = state.drivers.find(d => d.driver_id === action.payload.driverId);
        if (driver) {
          driver.isBlocked = true;
          driver.blockReason = action.payload.reason;
          driver.status = 'blocked';
        }
        if (state.selectedDriver?.driver_id === action.payload.driverId) {
          state.selectedDriver.isBlocked = true;
          state.selectedDriver.blockReason = action.payload.reason;
          state.selectedDriver.status = 'blocked';
        }
      });

    // Unblock driver
    builder
      .addCase(unblockDriver.fulfilled, (state, action) => {
        const driver = state.drivers.find(d => d.driver_id === action.payload.driverId);
        if (driver) {
          driver.isBlocked = false;
          driver.blockReason = undefined;
          driver.status = 'offline';
        }
        if (state.selectedDriver?.driver_id === action.payload.driverId) {
          state.selectedDriver.isBlocked = false;
          state.selectedDriver.blockReason = undefined;
          state.selectedDriver.status = 'offline';
        }
      });
  },
});

export const { setFilters, clearFilters, clearError, clearSelectedDriver } = driversSlice.actions;
export default driversSlice.reducer;