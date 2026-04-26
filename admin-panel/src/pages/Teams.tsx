import React, { useEffect, useState } from 'react';
import {
  Card,
  Table,
  Button,
  Space,
  Tag,
  Modal,
  Form,
  Input,
  Switch,
  Popconfirm,
  Typography,
  App as AntdApp,
  Empty,
  Statistic,
  Row,
  Col,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  TeamOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { teamsAPI } from '../services/api';

const { Title, Text } = Typography;

interface TeamRow {
  teamId: number;
  name: string;
  note: string | null;
  isActive: boolean;
  driverCount: number;
  createdAt: string;
}

const Teams: React.FC = () => {
  const { message } = AntdApp.useApp();
  const [rows, setRows] = useState<TeamRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<TeamRow | null>(null);
  const [form] = Form.useForm();

  const load = async () => {
    setLoading(true);
    try {
      const r = await teamsAPI.getAllTeams();
      if (r.success) setRows((r.data as any) ?? []);
    } catch (e) {
      console.error('[Teams] load failed:', e);
      message.error('車隊列表載入失敗');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleAdd = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ isActive: true });
    setModalOpen(true);
  };

  const handleEdit = (row: TeamRow) => {
    setEditing(row);
    form.setFieldsValue({
      name: row.name,
      note: row.note,
      isActive: row.isActive,
    });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (editing) {
        const r = await teamsAPI.updateTeam(editing.teamId, values);
        if (r.success) {
          message.success('車隊已更新');
          setModalOpen(false);
          load();
        } else {
          message.error(r.error || '更新失敗');
        }
      } else {
        const r = await teamsAPI.createTeam(values);
        if (r.success) {
          message.success('車隊已新增');
          setModalOpen(false);
          load();
        } else {
          message.error(r.error || '新增失敗');
        }
      }
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e?.response?.data?.error || e?.message || '操作失敗');
    }
  };

  const handleDelete = async (teamId: number, driverCount: number) => {
    if (driverCount > 0) {
      message.warning(`此車隊仍有 ${driverCount} 位司機，請先將司機調離後再停用`);
      return;
    }
    try {
      const r = await teamsAPI.deleteTeam(teamId);
      if (r.success) {
        message.success('車隊已停用');
        load();
      } else {
        message.error(r.error || '停用失敗');
      }
    } catch (e: any) {
      message.error(e?.response?.data?.error || '停用失敗');
    }
  };

  const activeCount = rows.filter((r) => r.isActive).length;
  const totalDrivers = rows.reduce((sum, r) => sum + (r.driverCount || 0), 0);

  const columns = [
    {
      title: '車隊名稱',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, row: TeamRow) => (
        <Space direction="vertical" size={0}>
          <Text strong style={{ fontSize: 16 }}>{name}</Text>
          {row.note && <Text type="secondary" style={{ fontSize: 12 }}>{row.note}</Text>}
        </Space>
      ),
    },
    {
      title: '司機數',
      dataIndex: 'driverCount',
      key: 'driverCount',
      width: 100,
      align: 'center' as const,
      render: (n: number) => (
        <Tag color={n > 0 ? 'blue' : 'default'} style={{ fontSize: 14 }}>
          {n} 位
        </Tag>
      ),
      sorter: (a: TeamRow, b: TeamRow) => (a.driverCount || 0) - (b.driverCount || 0),
    },
    {
      title: '狀態',
      dataIndex: 'isActive',
      key: 'isActive',
      width: 100,
      align: 'center' as const,
      render: (active: boolean) => (
        <Tag color={active ? 'green' : 'default'}>{active ? '啟用中' : '已停用'}</Tag>
      ),
      filters: [
        { text: '啟用中', value: true },
        { text: '已停用', value: false },
      ],
      onFilter: (val: any, row: TeamRow) => row.isActive === val,
    },
    {
      title: '建立時間',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 160,
      render: (t: string) => (t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '-'),
    },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      render: (_: any, row: TeamRow) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(row)}>
            編輯
          </Button>
          {row.isActive && (
            <Popconfirm
              title="確認停用此車隊？"
              description={
                row.driverCount > 0
                  ? `此車隊仍有 ${row.driverCount} 位司機，建議先調動再停用`
                  : '停用後新增司機時無法選擇此車隊'
              }
              onConfirm={() => handleDelete(row.teamId, row.driverCount)}
              okText="停用"
              cancelText="取消"
              okButtonProps={{ danger: true }}
            >
              <Button size="small" danger icon={<DeleteOutlined />}>
                停用
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Title level={3} style={{ margin: 0 }}>
            <TeamOutlined style={{ marginRight: 8, color: '#1976D2' }} />
            車隊管理
          </Title>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
              重新載入
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              新增車隊
            </Button>
          </Space>
        </div>

        <Row gutter={16}>
          <Col span={8}>
            <Card>
              <Statistic title="總車隊數" value={rows.length} suffix="個" valueStyle={{ color: '#1976D2' }} />
            </Card>
          </Col>
          <Col span={8}>
            <Card>
              <Statistic title="啟用中" value={activeCount} suffix="個" valueStyle={{ color: '#4CAF50' }} />
            </Card>
          </Col>
          <Col span={8}>
            <Card>
              <Statistic title="總司機數" value={totalDrivers} suffix="位" valueStyle={{ color: '#FF9800' }} />
            </Card>
          </Col>
        </Row>

        <Card>
          {rows.length === 0 && !loading ? (
            <Empty description="尚無車隊" />
          ) : (
            <Table columns={columns} dataSource={rows} rowKey="teamId" loading={loading} pagination={{ pageSize: 20 }} />
          )}
        </Card>
      </Space>

      <Modal
        title={editing ? '編輯車隊' : '新增車隊'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        okText="儲存"
        cancelText="取消"
        width={520}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            label="車隊名稱"
            name="name"
            rules={[
              { required: true, message: '請輸入車隊名稱' },
              { max: 100, message: '不可超過 100 字' },
            ]}
          >
            <Input placeholder="例：花蓮計程車公會" />
          </Form.Item>

          <Form.Item label="備註" name="note">
            <Input.TextArea
              rows={3}
              placeholder="例：固定折扣 10 元、主要服務市區"
              maxLength={500}
              showCount
            />
          </Form.Item>

          {editing && (
            <Form.Item label="啟用狀態" name="isActive" valuePropName="checked">
              <Switch checkedChildren="啟用中" unCheckedChildren="已停用" />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  );
};

export default Teams;
