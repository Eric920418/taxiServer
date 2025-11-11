import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { passengerAPI } from '../../services/api';
import { Passenger, FilterOptions } from '../../types';

interface PassengersState {
  passengers: Passenger[];
  selectedPassenger: Passenger | null;
  loading: boolean;
  error: string | null;
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

const initialState: PassengersState = {
  passengers: [],
  selectedPassenger: null,
  loading: false,
  error: null,
  pagination: {
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 0,
  },
};

export const fetchPassengers = createAsyncThunk(
  'passengers/fetchPassengers',
  async ({ filters, page, pageSize }: { filters?: FilterOptions; page?: number; pageSize?: number }) => {
    const response = await passengerAPI.getPassengers(filters, page, pageSize);
    if (response.success && response.data) {
      return response.data;
    }
    throw new Error(response.error || 'Failed to fetch passengers');
  }
);

export const blockPassenger = createAsyncThunk(
  'passengers/blockPassenger',
  async ({ passengerId, reason }: { passengerId: string; reason: string }) => {
    const response = await passengerAPI.blockPassenger(passengerId, reason);
    if (response.success) {
      return { passengerId, blocked: true, reason };
    }
    throw new Error(response.error || 'Failed to block passenger');
  }
);

export const unblockPassenger = createAsyncThunk(
  'passengers/unblockPassenger',
  async (passengerId: string) => {
    const response = await passengerAPI.unblockPassenger(passengerId);
    if (response.success) {
      return { passengerId, blocked: false };
    }
    throw new Error(response.error || 'Failed to unblock passenger');
  }
);

const passengersSlice = createSlice({
  name: 'passengers',
  initialState,
  reducers: {
    clearError: (state) => {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchPassengers.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchPassengers.fulfilled, (state, action) => {
        state.loading = false;
        state.passengers = action.payload.items;
        state.pagination = action.payload.pagination;
      })
      .addCase(fetchPassengers.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message || 'Failed to fetch passengers';
      });
  },
});

export const { clearError } = passengersSlice.actions;
export default passengersSlice.reducer;