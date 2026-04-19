import React, { useEffect, useState, useCallback } from 'react';
import {
  Table, Button, Modal, Form, Input, InputNumber, Select, Space, Tag,
  Popconfirm, Drawer, Timeline, Typography, Row, Col, App as AntdApp,
  Tooltip, Switch, Alert, Collapse,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined,
  HistoryOutlined, SearchOutlined, UndoOutlined, EnvironmentOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { landmarkAPI, type Landmark, type LandmarkInput, type LandmarkAudit } from '../services/api';
import GoogleMapsPicker, { type GoogleMapsPickerChange } from '../components/GoogleMapsPicker';
import dayjs from 'dayjs';

const { Title, Text } = Typography;

const CATEGORY_OPTIONS = [
  { value: 'TRANSPORT', label: '交通', color: 'blue' },
  { value: 'MEDICAL', label: '醫療', color: 'red' },
  { value: 'SCHOOL', label: '學校', color: 'cyan' },
  { value: 'COMMERCIAL', label: '商業', color: 'orange' },
  { value: 'GOVERNMENT', label: '政府', color: 'purple' },
  { value: 'ATTRACTION', label: '景點', color: 'green' },
  { value: 'HOTEL', label: '飯店', color: 'gold' },
  { value: 'TOWNSHIP', label: '鄉鎮', color: 'default' },
];

const DISTRICT_OPTIONS = [
  '花蓮市', '吉安鄉', '新城鄉', '壽豐鄉', '秀林鄉',
  '鳳林鎮', '光復鄉', '豐濱鄉', '瑞穗鄉', '玉里鎮',
  '富里鄉', '卓溪鄉', '萬榮鄉',
];

const Landmarks: React.FC = () => {
  const { message } = AntdApp.useApp();

  const [list, setList] = useState<Landmark[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string | undefined>();
  const [districtFilter, setDistrictFilter] = useState<string | undefined>();
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [indexBuiltAt, setIndexBuiltAt] = useState<string | null>(null);

  // Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Landmark | null>(null);
  const [form] = Form.useForm<LandmarkInput>();
  const [formLat, setFormLat] = useState<number | null>(null);
  const [formLng, setFormLng] = useState<number | null>(null);

  // Audit Drawer
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditData, setAuditData] = useState<LandmarkAudit[]>([]);
  const [auditLandmarkName, setAuditLandmarkName] = useState('');

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await landmarkAPI.list({
        q: query || undefined,
        category: categoryFilter,
        district: districtFilter,
        include_deleted: includeDeleted,
        page,
        page_size: pageSize,
      });
      if (res.data.success) {
        setList(res.data.data);
        setTotal(res.data.pagination.total);
        setIndexBuiltAt(res.data.index_built_at);
      } else {
        message.error(res.data.error || '查詢失敗');
      }
    } catch (err: any) {
      // 根據 CLAUDE.md 要求：錯誤必須完整顯示在前端
      const detail = err.response?.data?.error || err.message;
      const stack = err.response?.data?.stack || err.stack;
      message.error({
        content: `查詢失敗：${detail}${stack ? `\n\n${stack}` : ''}`,
        duration: 8,
        style: { whiteSpace: 'pre-wrap' },
      });
    } finally {
      setLoading(false);
    }
  }, [query, categoryFilter, districtFilter, includeDeleted, page, pageSize, message]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ priority: 5, category: 'COMMERCIAL', district: '花蓮市' });
    setFormLat(null);
    setFormLng(null);
    setModalOpen(true);
  };

  const openEdit = async (landmark: Landmark) => {
    // 重新取完整資料（含 aliases）
    try {
      const res = await landmarkAPI.get(landmark.id);
      if (res.data.success) {
        const full = res.data.data as Landmark;
        setEditing(full);
        const aliasList = (full.aliases || []).filter((a) => a.type === 'ALIAS').map((a) => a.alias);
        const taigiList = (full.aliases || []).filter((a) => a.type === 'TAIGI').map((a) => a.alias);
        const lat = parseFloat(full.lat as string);
        const lng = parseFloat(full.lng as string);
        form.setFieldsValue({
          name: full.name,
          lat,
          lng,
          address: full.address,
          category: full.category,
          district: full.district,
          priority: full.priority,
          dropoff_lat: full.dropoff_lat ? parseFloat(full.dropoff_lat as string) : null,
          dropoff_lng: full.dropoff_lng ? parseFloat(full.dropoff_lng as string) : null,
          dropoff_address: full.dropoff_address,
          aliases: aliasList,
          taigi_aliases: taigiList,
        });
        setFormLat(lat);
        setFormLng(lng);
        setModalOpen(true);
      }
    } catch (err: any) {
      message.error(err.response?.data?.error || err.message);
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      const payload: LandmarkInput = {
        ...values,
        aliases: values.aliases || [],
        taigi_aliases: values.taigi_aliases || [],
      };

      if (editing) {
        const res = await landmarkAPI.update(editing.id, payload);
        if (res.data.success) {
          message.success('地標已更新，記憶體索引已重建');
          setModalOpen(false);
          fetchList();
        }
      } else {
        const res = await landmarkAPI.create(payload);
        if (res.data.success) {
          message.success('地標已新增');
          setModalOpen(false);
          fetchList();
        }
      }
    } catch (err: any) {
      if (err.errorFields) return; // antd 表單驗證錯誤，已在欄位顯示
      const detail = err.response?.data?.error || err.message;
      const stack = err.response?.data?.stack || '';
      message.error({
        content: `儲存失敗：${detail}${stack ? `\n\n${stack}` : ''}`,
        duration: 10,
        style: { whiteSpace: 'pre-wrap' },
      });
    }
  };

  const handleDelete = async (id: number) => {
    try {
      const res = await landmarkAPI.remove(id);
      if (res.data.success) {
        message.success('已軟刪除（可復原）');
        fetchList();
      }
    } catch (err: any) {
      message.error(err.response?.data?.error || err.message);
    }
  };

  const handleRestore = async (id: number) => {
    try {
      const res = await landmarkAPI.restore(id);
      if (res.data.success) {
        message.success('已復原');
        fetchList();
      }
    } catch (err: any) {
      message.error(err.response?.data?.error || err.message);
    }
  };

  const handleRebuildIndex = async () => {
    try {
      const res = await landmarkAPI.rebuildIndex();
      if (res.data.success) {
        message.success(`記憶體索引已重建（${dayjs(res.data.built_at).format('HH:mm:ss')}）`);
        setIndexBuiltAt(res.data.built_at);
      }
    } catch (err: any) {
      message.error(err.response?.data?.error || err.message);
    }
  };

  const openAudit = async (landmark: Landmark) => {
    try {
      const res = await landmarkAPI.audit(landmark.id);
      if (res.data.success) {
        setAuditData(res.data.data);
        setAuditLandmarkName(landmark.name);
        setAuditOpen(true);
      }
    } catch (err: any) {
      message.error(err.response?.data?.error || err.message);
    }
  };

  const columns: ColumnsType<Landmark> = [
    {
      title: '名稱',
      dataIndex: 'name',
      width: 180,
      render: (name, row) => (
        <Space>
          <Text strong={!row.deleted_at} delete={!!row.deleted_at}>{name}</Text>
          {row.deleted_at && <Tag color="red">已刪除</Tag>}
        </Space>
      ),
    },
    {
      title: '分類',
      dataIndex: 'category',
      width: 80,
      render: (cat) => {
        const opt = CATEGORY_OPTIONS.find((o) => o.value === cat);
        return <Tag color={opt?.color}>{opt?.label || cat}</Tag>;
      },
    },
    {
      title: '行政區',
      dataIndex: 'district',
      width: 100,
    },
    {
      title: '座標',
      width: 180,
      render: (_, row) => (
        <Text copyable style={{ fontFamily: 'monospace', fontSize: 12 }}>
          {parseFloat(row.lat as string).toFixed(6)}, {parseFloat(row.lng as string).toFixed(6)}
        </Text>
      ),
    },
    {
      title: '優先級',
      dataIndex: 'priority',
      width: 80,
      align: 'center',
    },
    {
      title: '別名數',
      dataIndex: 'alias_count',
      width: 80,
      align: 'center',
    },
    {
      title: '最後更新',
      dataIndex: 'updated_at',
      width: 140,
      render: (date) => dayjs(date).format('MM-DD HH:mm'),
    },
    {
      title: '操作',
      width: 220,
      fixed: 'right',
      render: (_, row) => (
        <Space size="small">
          {!row.deleted_at ? (
            <>
              <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
                編輯
              </Button>
              <Popconfirm
                title={`確定刪除「${row.name}」？`}
                description="軟刪除，可透過顯示已刪除 → 復原"
                onConfirm={() => handleDelete(row.id)}
              >
                <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                  刪除
                </Button>
              </Popconfirm>
            </>
          ) : (
            <Button type="link" size="small" icon={<UndoOutlined />} onClick={() => handleRestore(row.id)}>
              復原
            </Button>
          )}
          <Tooltip title="審計歷史">
            <Button type="link" size="small" icon={<HistoryOutlined />} onClick={() => openAudit(row)} />
          </Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Title level={3}>
        <EnvironmentOutlined /> 地標管理
        <Text type="secondary" style={{ fontSize: 14, marginLeft: 12 }}>
          {indexBuiltAt && `索引最後重建：${dayjs(indexBuiltAt).format('HH:mm:ss')}`}
        </Text>
      </Title>

      <Space style={{ marginBottom: 16, width: '100%', flexWrap: 'wrap' }}>
        <Input
          placeholder="搜尋名稱或別名"
          prefix={<SearchOutlined />}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onPressEnter={() => { setPage(1); fetchList(); }}
          style={{ width: 240 }}
          allowClear
        />
        <Select
          placeholder="分類"
          value={categoryFilter}
          onChange={(v) => { setCategoryFilter(v); setPage(1); }}
          allowClear
          style={{ width: 120 }}
          options={CATEGORY_OPTIONS.map((c) => ({ value: c.value, label: c.label }))}
        />
        <Select
          placeholder="行政區"
          value={districtFilter}
          onChange={(v) => { setDistrictFilter(v); setPage(1); }}
          allowClear
          style={{ width: 140 }}
          options={DISTRICT_OPTIONS.map((d) => ({ value: d, label: d }))}
        />
        <Space>
          <Switch
            checked={includeDeleted}
            onChange={(v) => { setIncludeDeleted(v); setPage(1); }}
          />
          <Text>顯示已刪除</Text>
        </Space>
        <Button icon={<ReloadOutlined />} onClick={fetchList}>刷新</Button>
        <Button onClick={handleRebuildIndex}>手動重建索引</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新增地標
        </Button>
      </Space>

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
        scroll={{ x: 1100 }}
      />

      {/* 新增/編輯 Modal */}
      <Modal
        title={editing ? `編輯地標 #${editing.id}` : '新增地標'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        okText="儲存"
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
              <Form.Item
                label="正式名稱"
                name="name"
                rules={[{ required: true, message: '請輸入名稱' }]}
              >
                <Input placeholder="例：花蓮火車站" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                label="分類"
                name="category"
                rules={[{ required: true }]}
              >
                <Select options={CATEGORY_OPTIONS.map((c) => ({ value: c.value, label: c.label }))} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                label="優先級 (0-10)"
                name="priority"
                rules={[{ required: true }]}
              >
                <InputNumber min={0} max={10} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                label="行政區"
                name="district"
                rules={[{ required: true }]}
              >
                <Select
                  showSearch
                  options={DISTRICT_OPTIONS.map((d) => ({ value: d, label: d }))}
                />
              </Form.Item>
            </Col>
            <Col span={16}>
              <Form.Item
                label="完整地址"
                name="address"
                rules={[{ required: true }]}
              >
                <Input placeholder="例：花蓮縣花蓮市站前路" />
              </Form.Item>
            </Col>
          </Row>

          {/* 經緯度隱藏 — 由地圖自動填，客服不用碰 */}
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
            message="在下方地圖上搜尋「慈濟醫院」「花蓮火車站」等名稱，選中後會自動填入地址、座標與建議別名。冷門小店可直接點擊地圖定位。"
            style={{ marginBottom: 12 }}
          />

          <GoogleMapsPicker
            lat={formLat}
            lng={formLng}
            onChange={(d: GoogleMapsPickerChange) => {
              form.setFieldsValue({ lat: d.lat, lng: d.lng });
              setFormLat(d.lat);
              setFormLng(d.lng);

              // 只有新增時才用 Google 建議的 name/address 覆蓋（編輯時保留原有值避免誤改）
              const isCreating = !editing;
              if (isCreating && d.name && !form.getFieldValue('name')) {
                form.setFieldsValue({ name: d.name });
              }
              if (isCreating && d.address) {
                form.setFieldsValue({ address: d.address });
              }

              // 合併建議別名（去重）
              if (d.suggestedAliases && d.suggestedAliases.length > 0) {
                const current: string[] = form.getFieldValue('aliases') || [];
                const merged = Array.from(new Set([...current, ...d.suggestedAliases]));
                form.setFieldsValue({ aliases: merged });
              }
            }}
            height={340}
          />

          <Title level={5} style={{ marginTop: 16 }}>別名（幫助語音/文字叫車匹配）</Title>
          <Form.Item
            label="一般別名（按 Enter、逗號或空格分隔多筆）"
            name="aliases"
            tooltip="Google 搜尋地點時會自動建議，你可以再增刪"
          >
            <Select mode="tags" tokenSeparators={[',', ' ', '、']} placeholder="例如：火車站、車站、花蓮站" />
          </Form.Item>

          <Form.Item
            label="台語別名（Whisper 語音容錯用，可空）"
            name="taigi_aliases"
            tooltip="Whisper 在台語腔調下可能轉出的同音字，例如：火車頭、飛機厝"
          >
            <Select mode="tags" tokenSeparators={[',', ' ', '、']} />
          </Form.Item>

          <Collapse
            ghost
            items={[{
              key: 'advanced',
              label: '🔧 進階：司機停靠點（僅車站/醫院/機場等有明確下車點需要）',
              children: (
                <Row gutter={16}>
                  <Col span={8}>
                    <Form.Item label="停靠點緯度" name="dropoff_lat">
                      <InputNumber style={{ width: '100%' }} step={0.000001} precision={6} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item label="停靠點經度" name="dropoff_lng">
                      <InputNumber style={{ width: '100%' }} step={0.000001} precision={6} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item label="停靠點地址" name="dropoff_address">
                      <Input placeholder="可空" />
                    </Form.Item>
                  </Col>
                </Row>
              ),
            }]}
          />
        </Form>
      </Modal>

      {/* 審計歷史 Drawer */}
      <Drawer
        title={`審計歷史：${auditLandmarkName}`}
        open={auditOpen}
        onClose={() => setAuditOpen(false)}
        width={640}
      >
        {auditData.length === 0 ? (
          <Text type="secondary">無歷史紀錄</Text>
        ) : (
          <Timeline
            items={auditData.map((a) => ({
              color: a.action === 'CREATE' ? 'green' :
                     a.action === 'DELETE' ? 'red' :
                     a.action === 'RESTORE' ? 'blue' : 'gray',
              children: (
                <div>
                  <Space>
                    <Tag>{a.action}</Tag>
                    <Text>{a.admin_username || a.admin_id}</Text>
                    <Text type="secondary">{dayjs(a.created_at).format('YYYY-MM-DD HH:mm:ss')}</Text>
                  </Space>
                  {(a.before_data || a.after_data) && (
                    <div style={{ marginTop: 8 }}>
                      <details>
                        <summary style={{ cursor: 'pointer', color: '#1677ff' }}>查看 diff</summary>
                        <Row gutter={8} style={{ marginTop: 8 }}>
                          <Col span={12}>
                            <Text type="secondary">Before:</Text>
                            <pre style={{ fontSize: 11, background: '#fafafa', padding: 8, maxHeight: 300, overflow: 'auto' }}>
                              {JSON.stringify(a.before_data, null, 2) || '—'}
                            </pre>
                          </Col>
                          <Col span={12}>
                            <Text type="secondary">After:</Text>
                            <pre style={{ fontSize: 11, background: '#f6ffed', padding: 8, maxHeight: 300, overflow: 'auto' }}>
                              {JSON.stringify(a.after_data, null, 2) || '—'}
                            </pre>
                          </Col>
                        </Row>
                      </details>
                    </div>
                  )}
                </div>
              ),
            }))}
          />
        )}
      </Drawer>
    </div>
  );
};

export default Landmarks;
