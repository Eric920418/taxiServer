import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/**
 * 使用原生 Leaflet（非 react-leaflet，因為 R19 支援未穩）
 * 點擊地圖即更新 marker，同步回父層的 lat/lng
 */

// 修正 Leaflet 預設 marker icon 路徑（Vite 打包會丟路徑）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

interface Props {
  lat: number | null;
  lng: number | null;
  onChange: (lat: number, lng: number) => void;
  height?: number;
}

const HUALIEN_CENTER: [number, number] = [23.9769, 121.6073]; // 花蓮市中心

const LandmarkMapPicker: React.FC<Props> = ({ lat, lng, onChange, height = 300 }) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);

  // 初始化地圖（只跑一次）
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current).setView(
      lat && lng ? [lat, lng] : HUALIEN_CENTER,
      lat && lng ? 16 : 12
    );

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(map);

    map.on('click', (e: L.LeafletMouseEvent) => {
      const newLat = parseFloat(e.latlng.lat.toFixed(6));
      const newLng = parseFloat(e.latlng.lng.toFixed(6));
      onChange(newLat, newLng);
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 當 lat/lng 改變，更新 marker
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (lat != null && lng != null) {
      if (markerRef.current) {
        markerRef.current.setLatLng([lat, lng]);
      } else {
        markerRef.current = L.marker([lat, lng]).addTo(map);
      }
      // 若點位離當前中心很遠，移動地圖過去
      const current = map.getCenter();
      if (Math.abs(current.lat - lat) > 0.01 || Math.abs(current.lng - lng) > 0.01) {
        map.setView([lat, lng], Math.max(map.getZoom(), 15));
      }
    } else if (markerRef.current) {
      markerRef.current.remove();
      markerRef.current = null;
    }
  }, [lat, lng]);

  return (
    <div>
      <div
        ref={mapContainerRef}
        style={{
          height,
          width: '100%',
          borderRadius: 6,
          border: '1px solid #d9d9d9',
        }}
      />
      <div style={{ marginTop: 4, fontSize: 12, color: '#888' }}>
        點擊地圖即可設定座標 {lat != null && lng != null && (
          <>· 目前：{lat.toFixed(6)}, {lng.toFixed(6)}</>
        )}
      </div>
    </div>
  );
};

export default LandmarkMapPicker;
