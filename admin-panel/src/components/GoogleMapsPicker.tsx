import React, { useEffect, useRef, useState } from 'react';
import { setOptions, importLibrary } from '@googlemaps/js-api-loader';
import { Input, Alert, Spin, Typography, Space } from 'antd';
import { SearchOutlined, AimOutlined } from '@ant-design/icons';
import { getGoogleMapsKey } from '../services/api';

const { Text } = Typography;

/**
 * GoogleMapsPicker — 取代原 Leaflet 版本
 *
 * 功能：
 *   1. Places Autocomplete 搜尋框（鎖定花蓮縣範圍，中文介面）
 *   2. 選地點自動帶入 name / address / lat / lng + 建議別名
 *   3. 地圖 marker 可拖曳微調；地圖也可點擊定位（冷門店沒收錄 Places 時用）
 *   4. 緯度經度預設隱藏，只給工程師看的小字顯示（可複製）
 *
 * 這個元件不管理 form state，所有變動透過 onChange 傳給父表單。
 */

export interface GoogleMapsPickerChange {
  lat: number;
  lng: number;
  name?: string;
  address?: string;
  suggestedAliases?: string[];
}

interface Props {
  lat: number | null;
  lng: number | null;
  onChange: (data: GoogleMapsPickerChange) => void;
  height?: number;
  /** 是否顯示小字座標（預設 true，若父層已另有顯示可設 false） */
  showCoordText?: boolean;
}

// 花蓮縣地理圍籬（與 Server HualienAddressDB.isWithinHualienBounds 對齊）
const HUALIEN_CENTER = { lat: 23.9769, lng: 121.6073 };
const HUALIEN_BOUNDS = {
  south: 23.20, north: 24.16,
  west: 121.30, east: 121.66,
};

/**
 * 從 Google Places 的 name + types 推測可能的別名
 * 例：「花蓮慈濟醫學中心」→ ["慈濟醫學中心", "慈濟醫院", "慈濟"]
 */
function suggestAliasesFromPlace(name?: string, types?: string[]): string[] {
  if (!name) return [];
  const set = new Set<string>();

  // 去「花蓮」「花蓮縣」前綴
  for (const prefix of ['花蓮縣', '花蓮市', '花蓮']) {
    if (name.startsWith(prefix) && name.length > prefix.length) {
      set.add(name.slice(prefix.length));
    }
  }

  // 去常見機構後綴，產生較短的通俗名
  const suffixes = [
    '大飯店', '國際飯店', '大酒店', '飯店', '旅館', '商旅', '民宿',
    '醫學中心', '醫院', '診所', '衛生所',
    '科技大學', '大學', '高中', '國中', '國小', '國民小學', '國民中學',
    '風景區', '遊樂區', '觀光區',
    '百貨', '購物中心', '夜市', '市場',
    '鄉公所', '鎮公所', '區公所', '縣政府', '市政府',
    '火車站', '車站', '轉運站', '機場', '航空站', '港',
  ];
  for (const s of suffixes) {
    if (name.endsWith(s) && name.length > s.length) {
      const shorter = name.slice(0, -s.length);
      if (shorter.length >= 2) set.add(shorter);
      // 同時把「花蓮XXX」+「XXX」都加
      if (shorter.startsWith('花蓮') && shorter.length > 2) {
        set.add(shorter.slice(2));
      }
      break;
    }
  }

  // 根據 types 推幾個常見通用稱呼
  if (types?.includes('train_station') && !name.includes('火車站')) {
    set.add(name + '火車站');
  }
  if (types?.includes('hospital') && !name.endsWith('醫院')) {
    set.add(name + '醫院');
  }

  return Array.from(set).filter((s) => s.length >= 2 && s !== name);
}

const GoogleMapsPicker: React.FC<Props> = ({
  lat, lng, onChange, height = 360, showCoordText = true,
}) => {
  const mapDivRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 初始化 SDK + Map + Autocomplete（只跑一次）
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const apiKey = await getGoogleMapsKey();
        // v2 functional API — Loader class 已 deprecated
        setOptions({
          key: apiKey,
          v: 'weekly',
          libraries: ['places'],
          language: 'zh-TW',
          region: 'TW',
        });
        await importLibrary('maps');
        await importLibrary('places');
        if (cancelled || !mapDivRef.current) return;

        const initialCenter = (lat != null && lng != null) ? { lat, lng } : HUALIEN_CENTER;
        const initialZoom = (lat != null && lng != null) ? 16 : 12;

        const map = new google.maps.Map(mapDivRef.current, {
          center: initialCenter,
          zoom: initialZoom,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
        });
        mapRef.current = map;

        // 點擊地圖 → 設 marker（給冷門店沒收錄 Places 時用）
        map.addListener('click', (e: google.maps.MapMouseEvent) => {
          if (!e.latLng) return;
          const newLat = parseFloat(e.latLng.lat().toFixed(6));
          const newLng = parseFloat(e.latLng.lng().toFixed(6));
          onChange({ lat: newLat, lng: newLng });
        });

        // Places Autocomplete
        if (searchInputRef.current) {
          const ac = new google.maps.places.Autocomplete(searchInputRef.current, {
            bounds: new google.maps.LatLngBounds(
              { lat: HUALIEN_BOUNDS.south, lng: HUALIEN_BOUNDS.west },
              { lat: HUALIEN_BOUNDS.north, lng: HUALIEN_BOUNDS.east }
            ),
            strictBounds: false,
            componentRestrictions: { country: 'tw' },
            fields: ['name', 'formatted_address', 'geometry', 'types'],
          });
          ac.addListener('place_changed', () => {
            const place = ac.getPlace();
            if (!place.geometry?.location) return;
            const p = place.geometry.location;
            const newLat = parseFloat(p.lat().toFixed(6));
            const newLng = parseFloat(p.lng().toFixed(6));

            onChange({
              lat: newLat,
              lng: newLng,
              name: place.name,
              address: place.formatted_address,
              suggestedAliases: suggestAliasesFromPlace(place.name, place.types),
            });

            map.setCenter({ lat: newLat, lng: newLng });
            map.setZoom(16);
          });
          autocompleteRef.current = ac;
        }

        setLoading(false);
      } catch (e: any) {
        if (!cancelled) {
          setError(e.message || String(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (autocompleteRef.current) {
        google.maps.event.clearInstanceListeners(autocompleteRef.current);
      }
      if (markerRef.current) {
        markerRef.current.setMap(null);
        markerRef.current = null;
      }
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 同步 props lat/lng → marker
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (lat == null || lng == null) {
      if (markerRef.current) {
        markerRef.current.setMap(null);
        markerRef.current = null;
      }
      return;
    }

    const pos = { lat, lng };
    if (!markerRef.current) {
      const m = new google.maps.Marker({
        position: pos,
        map,
        draggable: true,
        animation: google.maps.Animation.DROP,
      });
      m.addListener('dragend', () => {
        const p = m.getPosition();
        if (!p) return;
        onChange({
          lat: parseFloat(p.lat().toFixed(6)),
          lng: parseFloat(p.lng().toFixed(6)),
        });
      });
      markerRef.current = m;
    } else {
      markerRef.current.setPosition(pos);
    }

    // 若 marker 離開可視範圍則跟著移動
    const currentCenter = map.getCenter();
    if (currentCenter) {
      const dLat = Math.abs(currentCenter.lat() - lat);
      const dLng = Math.abs(currentCenter.lng() - lng);
      if (dLat > 0.01 || dLng > 0.01) {
        map.setCenter(pos);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lng]);

  if (error) {
    return (
      <Alert
        type="error"
        message="Google Maps 載入失敗"
        description={
          <div>
            <div style={{ marginBottom: 8 }}>{error}</div>
            <div style={{ fontSize: 12, color: '#888' }}>
              檢查 Server `.env` 有無 `GOOGLE_MAPS_API_KEY`，以及該 Key 在 Google Cloud Console
              已啟用「Maps JavaScript API」「Places API」，並已加上 HTTP referrer 允許清單。
            </div>
          </div>
        }
      />
    );
  }

  return (
    <div style={{ position: 'relative' }}>
      <Input
        ref={(el) => {
          // antd Input 實際底層 DOM 要透過 input ref 拿
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          searchInputRef.current = (el as any)?.input ?? null;
        }}
        placeholder="搜尋地點（例：花蓮慈濟醫院、好樂迪）"
        prefix={<SearchOutlined />}
        size="large"
        style={{ marginBottom: 8 }}
        disabled={loading}
      />
      <Spin spinning={loading} tip="載入 Google Maps...">
        <div
          ref={mapDivRef}
          style={{
            height,
            width: '100%',
            borderRadius: 6,
            border: '1px solid #d9d9d9',
            background: '#f0f0f0',
          }}
        />
      </Spin>
      {showCoordText && lat != null && lng != null && (
        <Space style={{ marginTop: 6, fontSize: 12, color: '#888' }}>
          <AimOutlined />
          <Text type="secondary" copyable={{ text: `${lat}, ${lng}` }}>
            {lat.toFixed(6)}, {lng.toFixed(6)}
          </Text>
          <Text type="secondary">· 可拖曳 marker 或點擊地圖微調</Text>
        </Space>
      )}
    </div>
  );
};

export default GoogleMapsPicker;
