import React, { useEffect, useState, useCallback } from 'react';
import {
  Table,
  Card,
  Input,
  Select,
  Button,
  Space,
  Tag,
  Drawer,
  Descriptions,
  Typography,
  Row,
  Col,
  message,
} from 'antd';
import {
  PhoneOutlined,
  EyeOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { phoneCallAPI } from '../services/api';
import dayjs from 'dayjs';
import type { ColumnsType } from 'antd/es/table';

const { Text, Paragraph } = Typography;
const { Option } = Select;

// 後端回傳 camelCase
interface ParsedFields {
  pickup?: string;
  destination?: string;
  subsidy_type?: string;
  has_pet?: boolean;
  [key: string]: unknown;
}

interface PhoneCall {
  callId: string;
  callerNumber: string;
  createdAt: string;
  durationSeconds: number | null;
  transcript: string | null;
  processingStatus: string;
  eventType: string | null;
  orderId: string | null;
  parsedFields: ParsedFields | null;
  errorMessage: string | null;
}

const EVENT_TYPE_MAP: Record<string, { label: string; color: string }> = {
  NEW_ORDER: { label: '新訂單', color: 'blue' },
  URGE: { label: '催單', color: 'orange' },
  CANCEL: { label: '取消', color: 'red' },
  CHANGE: { label: '變更', color: 'purple' },
};

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  COMPLETED: { label: '完成', color: 'success' },
  FAILED: { label: '失敗', color: 'error' },
  PROCESSING: { label: '處理中', color: 'processing' },
  PENDING: { label: '待處理', color: 'default' },
  RECEIVED: { label: '已接收', color: 'default' },
};

const PhoneCalls: React.FC = () => {
  const [records, setRecords] = useState<PhoneCall[]>([]);
  const [loading, setLoading] = useState(false);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [callerSearch, setCallerSearch] = useState('');
  const [selectedRecord, setSelectedRecord] = useState<PhoneCall | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const fetchRecords = useCallback(async (page = 1, pageSize = 20) => {
    setLoading(true);
    try {
      const res = await phoneCallAPI.list({ page, pageSize, status: statusFilter });
      // 後端回傳 { calls: [...], total: N }
      const calls: PhoneCall[] = res.data?.calls ?? [];
      const total: number = res.data?.total ?? calls.length;

      // 若有搜尋號碼，在前端篩選（後端不支援此參數）
      const filtered = callerSearch
        ? calls.filter(c => c.callerNumber?.includes(callerSearch))
        : calls;

      setRecords(filtered);
      setPagination({ current: page, pageSize, total });
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string } }; message?: string };
      message.error(error?.response?.data?.message || error?.message || '載入失敗');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, callerSearch]);

  useEffect(() => {
    fetchRecords(1, pagination.pageSize);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  const handleSearch = () => {
    fetchRecords(1, pagination.pageSize);
  };

  const openDrawer = (record: PhoneCall) => {
    setSelectedRecord(record);
    setDrawerOpen(true);
  };

  const columns: ColumnsType<PhoneCall> = [
    {
      title: '時間',
      dataIndex: 'createdAt',
      width: 120,
      render: (v: string) => v ? dayjs(v).format('MM/DD HH:mm') : '—',
    },
    {
      title: '來電號碼',
      dataIndex: 'callerNumber',
      width: 130,
    },
    {
      title: '通話時長',
      dataIndex: 'durationSeconds',
      width: 90,
      render: (v: number | null) => v != null ? `${v} 秒` : '—',
    },
    {
      title: '說了什麼',
      dataIndex: 'transcript',
      ellipsis: true,
      render: (v: string | null) => {
        if (!v) return <Text type="secondary">（無逐字稿）</Text>;
        return (
          <Text ellipsis={{ tooltip: v }}>
            {v.length > 60 ? v.slice(0, 60) + '…' : v}
          </Text>
        );
      },
    },
    {
      title: '事件類型',
      dataIndex: 'eventType',
      width: 100,
      render: (v: string | null) => {
        if (!v) return '—';
        const info = EVENT_TYPE_MAP[v];
        return info ? <Tag color={info.color}>{info.label}</Tag> : <Tag>{v}</Tag>;
      },
    },
    {
      title: '狀態',
      dataIndex: 'processingStatus',
      width: 100,
      render: (v: string) => {
        const info = STATUS_MAP[v] || { label: v, color: 'default' };
        return <Tag color={info.color}>{info.label}</Tag>;
      },
    },
    {
      title: '關聯訂單',
      dataIndex: 'orderId',
      width: 120,
      render: (v: string | null) => v || '—',
    },
    {
      title: '操作',
      width: 80,
      render: (_: unknown, record: PhoneCall) => (
        <Button
          size="small"
          icon={<EyeOutlined />}
          onClick={() => openDrawer(record)}
        >
          查看
        </Button>
      ),
    },
  ];

  return (
    <div>
      <Card
        title={
          <Space>
            <PhoneOutlined />
            電話記錄
          </Space>
        }
        extra={
          <Button
            icon={<ReloadOutlined />}
            onClick={() => fetchRecords(pagination.current, pagination.pageSize)}
          >
            重新整理
          </Button>
        }
      >
        <Row gutter={12} style={{ marginBottom: 16 }}>
          <Col>
            <Select
              placeholder="所有狀態"
              allowClear
              style={{ width: 140 }}
              value={statusFilter}
              onChange={(v) => setStatusFilter(v)}
            >
              <Option value="COMPLETED">完成</Option>
              <Option value="FAILED">失敗</Option>
              <Option value="PROCESSING">處理中</Option>
              <Option value="PENDING">待處理</Option>
              <Option value="RECEIVED">已接收</Option>
            </Select>
          </Col>
          <Col>
            <Input
              placeholder="搜尋來電號碼"
              prefix={<SearchOutlined />}
              value={callerSearch}
              onChange={(e) => setCallerSearch(e.target.value)}
              onPressEnter={handleSearch}
              style={{ width: 200 }}
              allowClear
            />
          </Col>
          <Col>
            <Button type="primary" onClick={handleSearch}>搜尋</Button>
          </Col>
        </Row>

        <Table<PhoneCall>
          columns={columns}
          dataSource={records}
          rowKey="callId"
          loading={loading}
          pagination={{
            current: pagination.current,
            pageSize: pagination.pageSize,
            total: pagination.total,
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 筆`,
            onChange: (page, pageSize) => fetchRecords(page, pageSize),
          }}
          scroll={{ x: 900 }}
        />
      </Card>

      <Drawer
        title="電話記錄詳情"
        placement="right"
        width={520}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        destroyOnClose
      >
        {selectedRecord && (
          <Space direction="vertical" style={{ width: '100%' }} size="large">
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="來電號碼">
                {selectedRecord.callerNumber}
              </Descriptions.Item>
              <Descriptions.Item label="通話時間">
                {selectedRecord.createdAt
                  ? dayjs(selectedRecord.createdAt).format('YYYY/MM/DD HH:mm:ss')
                  : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="通話時長">
                {selectedRecord.durationSeconds != null
                  ? `${selectedRecord.durationSeconds} 秒`
                  : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="事件類型">
                {selectedRecord.eventType
                  ? (EVENT_TYPE_MAP[selectedRecord.eventType]
                    ? <Tag color={EVENT_TYPE_MAP[selectedRecord.eventType].color}>
                        {EVENT_TYPE_MAP[selectedRecord.eventType].label}
                      </Tag>
                    : selectedRecord.eventType)
                  : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="狀態">
                {(() => {
                  const info = STATUS_MAP[selectedRecord.processingStatus] || {
                    label: selectedRecord.processingStatus,
                    color: 'default',
                  };
                  return <Tag color={info.color}>{info.label}</Tag>;
                })()}
              </Descriptions.Item>
              <Descriptions.Item label="關聯訂單">
                {selectedRecord.orderId || '—'}
              </Descriptions.Item>
            </Descriptions>

            {selectedRecord.transcript && (
              <Card size="small" title="客人說了什麼（逐字稿）">
                <Paragraph
                  style={{ maxHeight: 200, overflowY: 'auto', whiteSpace: 'pre-wrap', margin: 0 }}
                >
                  {selectedRecord.transcript}
                </Paragraph>
              </Card>
            )}

            {selectedRecord.parsedFields && (
              <Card size="small" title="GPT 解析結果">
                <Descriptions column={1} size="small">
                  {selectedRecord.parsedFields.pickup && (
                    <Descriptions.Item label="上車地點">
                      {selectedRecord.parsedFields.pickup}
                    </Descriptions.Item>
                  )}
                  {selectedRecord.parsedFields.destination && (
                    <Descriptions.Item label="目的地">
                      {selectedRecord.parsedFields.destination}
                    </Descriptions.Item>
                  )}
                  {selectedRecord.parsedFields.subsidy_type && (
                    <Descriptions.Item label="補貼類型">
                      {selectedRecord.parsedFields.subsidy_type}
                    </Descriptions.Item>
                  )}
                  {selectedRecord.parsedFields.has_pet != null && (
                    <Descriptions.Item label="寵物">
                      {selectedRecord.parsedFields.has_pet ? '有' : '無'}
                    </Descriptions.Item>
                  )}
                </Descriptions>
              </Card>
            )}

            {selectedRecord.errorMessage && (
              <Card size="small" title="錯誤訊息" styles={{ header: { color: '#ff4d4f' } }}>
                <Text type="danger">{selectedRecord.errorMessage}</Text>
              </Card>
            )}
          </Space>
        )}
      </Drawer>
    </div>
  );
};

export default PhoneCalls;
