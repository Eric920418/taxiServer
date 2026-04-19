import React, { useEffect, useState, useCallback } from 'react';
import {
  Table, Button, Space, Tag, Typography, Select, Popconfirm, Modal, Form,
  Input, InputNumber, Row, Col, App as AntdApp, Card, Statistic, Alert,
} from 'antd';
import {
  ReloadOutlined, CheckCircleOutlined, CloseOutlined,
  PlusOutlined, QuestionCircleOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  addressFailureAPI, landmarkAPI,
  type AddressLookupFailure, type LandmarkInput,
} from '../services/api';
import GoogleMapsPicker, { type GoogleMapsPickerChange } from '../components/GoogleMapsPicker';
import dayjs from 'dayjs';

const { Title, Text, Paragraph } = Typography;

const CATEGORY_OPTIONS = [
  { value: 'TRANSPORT', label: '交通' },
  { value: 'MEDICAL', label: '醫療' },
  { value: 'SCHOOL', label: '學校' },
  { value: 'COMMERCIAL', label: '商業' },
  { value: 'GOVERNMENT', label: '政府' },
  { value: 'ATTRACTION', label: '景點' },
  { value: 'HOTEL', label: '飯店' },
  { value: 'TOWNSHIP', label: '鄉鎮' },
];
const DISTRICT_OPTIONS = [
  '花蓮市', '吉安鄉', '新城鄉', '壽豐鄉', '秀林鄉',
  '鳳林鎮', '光復鄉', '豐濱鄉', '瑞穗鄉', '玉里鎮',
  '富里鄉', '卓溪鄉', '萬榮鄉',
];

const SOURCE_COLORS: Record<string, string> = {
  LINE: 'green',
  PHONE: 'blue',
  APP_VOICE: 'orange',
};

const AddressFailures: React.FC = () => {
  const { message } = AntdApp.useApp();

  const [list, setList] = useState<(AddressLookupFailure & { resolved_landmark_name?: string })[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sourceFilter, setSourceFilter] = useState<string | undefined>();
  const [resolvedFilter, setResolvedFilter] = useState<string>('false');

  // 一鍵轉為新地標 Modal
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [creatingFrom, setCreatingFrom] = useState<AddressLookupFailure | null>(null);
  const [form] = Form.useForm<LandmarkInput>();
  const [formLat, setFormLat] = useState<number | null>(null);
  const [formLng, setFormLng] = useState<number | null>(null);

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await addressFailureAPI.list({
        source: sourceFilter,
        resolved: resolvedFilter === 'all' ? undefined : (resolvedFilter as any),
        page,
        page_size: pageSize,
      });
      if (res.data.success) {
        setList(res.data.data);
        setTotal(res.data.pagination.total);
      }
    } catch (err: any) {
      const detail = err.response?.data?.error || err.message;
      message.error({ content: `查詢失敗：${detail}`, duration: 8 });
    } finally {
      setLoading(false);
    }
  }, [sourceFilter, resolvedFilter, page, pageSize, message]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  const openCreateFromFailure = (failure: AddressLookupFailure) => {
    setCreatingFrom(failure);
    const google = failure.google_result as any;
    const bestMatch = failure.best_match as any;

    // 猜測分類與行政區（從原輸入關鍵字）
    const lat = google?.lat || bestMatch?.entry_lat || null;
    const lng = google?.lng || bestMatch?.entry_lng || null;

    form.resetFields();
    form.setFieldsValue({
      name: failure.query,
      lat: lat ? parseFloat(lat) : undefined,
      lng: lng ? parseFloat(lng) : undefined,
      address: google?.formattedAddress || bestMatch?.entry_address || '',
      category: 'COMMERCIAL',
      district: '花蓮市',
      priority: 5,
      // 自動把原用戶輸入加為別名 —— 下次相同查詢就能本地命中
      aliases: [failure.query],
      taigi_aliases: [],
    });
    setFormLat(lat ? parseFloat(lat) : null);
    setFormLng(lng ? parseFloat(lng) : null);
    setCreateModalOpen(true);
  };

  const handleCreateSubmit = async () => {
    try {
      const values = await form.validateFields();
      const res = await landmarkAPI.create({
        ...values,
        aliases: values.aliases || [],
        taigi_aliases: values.taigi_aliases || [],
      });
      if (res.data.success && creatingFrom) {
        const landmarkId = res.data.data.id;
        await addressFailureAPI.markResolved(creatingFrom.id, landmarkId);
        message.success(`地標「${values.name}」已新增，失敗記錄已歸檔`);
        setCreateModalOpen(false);
        fetchList();
      }
    } catch (err: any) {
      if (err.errorFields) return;
      const detail = err.response?.data?.error || err.message;
      const stack = err.response?.data?.stack || '';
      message.error({
        content: `新增失敗：${detail}${stack ? `\n\n${stack}` : ''}`,
        duration: 10,
        style: { whiteSpace: 'pre-wrap' },
      });
    }
  };

  const handleDismiss = async (id: number) => {
    try {
      const res = await addressFailureAPI.dismiss(id);
      if (res.data.success) {
        message.success('已忽略');
        fetchList();
      }
    } catch (err: any) {
      message.error(err.response?.data?.error || err.message);
    }
  };

  const columns: ColumnsType<AddressLookupFailure & { resolved_landmark_name?: string }> = [
    {
      title: '原始輸入',
      dataIndex: 'query',
      width: 220,
      render: (q) => <Text copyable strong>{q}</Text>,
    },
    {
      title: '來源',
      dataIndex: 'source',
      width: 90,
      render: (s) => <Tag color={SOURCE_COLORS[s] || 'default'}>{s}</Tag>,
    },
    {
      title: '次數',
      dataIndex: 'hit_count',
      width: 70,
      align: 'center',
      sorter: (a, b) => a.hit_count - b.hit_count,
      defaultSortOrder: 'descend',
    },
    {
      title: '本地匹配（低信心）',
      dataIndex: 'best_match',
      width: 200,
      render: (bm: any) => {
        if (!bm) return <Text type="secondary">—</Text>;
        return (
          <div style={{ fontSize: 12 }}>
            <div>→ {bm.entry_name}</div>
            <div style={{ color: '#999' }}>{bm.match_type} / conf {(bm.confidence * 100).toFixed(0)}%</div>
          </div>
        );
      },
    },
    {
      title: 'Google 補救',
      dataIndex: 'google_result',
      width: 220,
      render: (gr: any) => {
        if (!gr) return <Text type="secondary">無</Text>;
        return (
          <div style={{ fontSize: 12 }}>
            <div>{gr.formattedAddress || '—'}</div>
            <div style={{ color: '#999', fontFamily: 'monospace' }}>
              {gr.lat?.toFixed(6)}, {gr.lng?.toFixed(6)}
            </div>
          </div>
        );
      },
    },
    {
      title: '首次/末次',
      width: 180,
      render: (_, row) => (
        <div style={{ fontSize: 12 }}>
          <div>首次 {dayjs(row.first_seen_at).format('MM-DD HH:mm')}</div>
          <div style={{ color: '#999' }}>末次 {dayjs(row.last_seen_at).format('MM-DD HH:mm')}</div>
        </div>
      ),
    },
    {
      title: '狀態',
      width: 140,
      render: (_, row) => {
        if (row.resolved_landmark_id) {
          return (
            <Tag color="green" icon={<CheckCircleOutlined />}>
              已處理 → {row.resolved_landmark_name}
            </Tag>
          );
        }
        if ((row as any).dismissed_at) {
          return <Tag color="default">已忽略</Tag>;
        }
        return <Tag color="gold">待處理</Tag>;
      },
    },
    {
      title: '操作',
      width: 180,
      fixed: 'right',
      render: (_, row) => {
        if (row.resolved_landmark_id || (row as any).dismissed_at) {
          return <Text type="secondary">—</Text>;
        }
        return (
          <Space size="small">
            <Button
              type="primary"
              size="small"
              icon={<PlusOutlined />}
              onClick={() => openCreateFromFailure(row)}
            >
              轉為地標
            </Button>
            <Popconfirm
              title="忽略此記錄？"
              description="例如垃圾輸入或非實際地標"
              onConfirm={() => handleDismiss(row.id)}
            >
              <Button size="small" icon={<CloseOutlined />}>忽略</Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <Title level={3}>
        <QuestionCircleOutlined /> 待補齊地標
      </Title>
      <Paragraph type="secondary">
        當 LINE / 電話 / App 語音叫車輸入「找不到的地點」時，系統自動累積在這裡。
        相同輸入的次數越高，代表真實需求越大，建議優先補進地標庫。
      </Paragraph>

      <Card style={{ marginBottom: 16 }}>
        <Row gutter={16}>
          <Col span={8}>
            <Statistic title="目前顯示" value={total} />
          </Col>
          <Col span={16}>
            <Space>
              <Select
                value={resolvedFilter}
                onChange={(v) => { setResolvedFilter(v); setPage(1); }}
                style={{ width: 140 }}
                options={[
                  { value: 'false', label: '待處理' },
                  { value: 'true', label: '已處理' },
                  { value: 'all', label: '全部' },
                ]}
              />
              <Select
                placeholder="來源"
                value={sourceFilter}
                onChange={(v) => { setSourceFilter(v); setPage(1); }}
                allowClear
                style={{ width: 140 }}
                options={[
                  { value: 'LINE', label: 'LINE' },
                  { value: 'PHONE', label: '電話' },
                  { value: 'APP_VOICE', label: 'App 語音' },
                ]}
              />
              <Button icon={<ReloadOutlined />} onClick={fetchList}>刷新</Button>
            </Space>
          </Col>
        </Row>
      </Card>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={list}
        loading={loading}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 筆`,
          onChange: (p, ps) => { setPage(p); setPageSize(ps); },
        }}
        scroll={{ x: 1200 }}
      />

      {/* 一鍵新增地標 Modal */}
      <Modal
        title={creatingFrom ? `補齊地標（來源輸入：${creatingFrom.query}）` : '新增地標'}
        open={createModalOpen}
        onCancel={() => setCreateModalOpen(false)}
        onOk={handleCreateSubmit}
        okText="新增並歸檔"
        cancelText="取消"
        width={900}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          onValuesChange={(changed) => {
            if (changed.lat !== undefined) setFormLat(changed.lat ?? null);
            if (changed.lng !== undefined) setFormLng(changed.lng ?? null);
          }}
        >
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="正式名稱" name="name" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="分類" name="category" rules={[{ required: true }]}>
                <Select options={CATEGORY_OPTIONS} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="優先級" name="priority" rules={[{ required: true }]}>
                <InputNumber min={0} max={10} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={8}>
              <Form.Item label="行政區" name="district" rules={[{ required: true }]}>
                <Select showSearch options={DISTRICT_OPTIONS.map((d) => ({ value: d, label: d }))} />
              </Form.Item>
            </Col>
            <Col span={16}>
              <Form.Item label="地址" name="address" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
          </Row>

          {/* 經緯度隱藏 — 從地圖自動填，客服不用碰 */}
          <Form.Item name="lat" hidden rules={[
            { required: true, message: '請從地圖選地點' },
            { type: 'number', min: 23.0, max: 24.6, message: '座標須在花蓮縣範圍內' },
          ]}>
            <InputNumber />
          </Form.Item>
          <Form.Item name="lng" hidden rules={[
            { required: true, message: '請從地圖選地點' },
            { type: 'number', min: 121.0, max: 122.0, message: '座標須在花蓮縣範圍內' },
          ]}>
            <InputNumber />
          </Form.Item>

          <Alert
            type="info"
            showIcon
            message="地圖上搜尋用戶原輸入或其他關鍵字，選中後會自動填地址與座標。冷門地點可直接點擊地圖定位。"
            style={{ marginBottom: 12 }}
          />

          <GoogleMapsPicker
            lat={formLat}
            lng={formLng}
            onChange={(d: GoogleMapsPickerChange) => {
              form.setFieldsValue({ lat: d.lat, lng: d.lng });
              setFormLat(d.lat);
              setFormLng(d.lng);

              // Google 搜尋到地點 → 補地址（若還沒填）與合併建議別名
              if (d.address && !form.getFieldValue('address')) {
                form.setFieldsValue({ address: d.address });
              }
              if (d.suggestedAliases && d.suggestedAliases.length > 0) {
                const current: string[] = form.getFieldValue('aliases') || [];
                const merged = Array.from(new Set([...current, ...d.suggestedAliases]));
                form.setFieldsValue({ aliases: merged });
              }
            }}
            height={320}
          />

          <Form.Item
            label="別名（自動帶入原輸入與 Google 建議，可再補）"
            name="aliases"
            style={{ marginTop: 16 }}
            tooltip="原用戶輸入已自動加為別名，下次相同輸入即能本地命中"
          >
            <Select mode="tags" tokenSeparators={[',', ' ', '、']} />
          </Form.Item>

          <Form.Item label="台語別名（可空）" name="taigi_aliases">
            <Select mode="tags" tokenSeparators={[',', ' ', '、']} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default AddressFailures;
