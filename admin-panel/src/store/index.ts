import { configureStore } from '@reduxjs/toolkit';
import authReducer from './slices/authSlice';
import driversReducer from './slices/driversSlice';
import passengersReducer from './slices/passengersSlice';
import ordersReducer from './slices/ordersSlice';
import statisticsReducer from './slices/statisticsSlice';

export const store = configureStore({
  reducer: {
    auth: authReducer,
    drivers: driversReducer,
    passengers: passengersReducer,
    orders: ordersReducer,
    statistics: statisticsReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;