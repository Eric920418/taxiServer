import React, { useState, useEffect } from 'react';
import {
  Card,
  Table,
  Button,
  Space,
  Modal,
  Form,
  Input,
  Select,
  Tag,
  message,
  Popconfirm,
  Typography,
  Switch,
  Row,
  Col,
  Statistic,
  Descriptions,
  Drawer,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  LockOutlined,
  UnlockOutlined,
  UserOutlined,
  MailOutlined,
  PhoneOutlined,
  KeyOutlined,
  EyeOutlined,
  ReloadOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';

const { Title, Text } = Typography;
const { Option } = Select;

interface Admin {
  admin_id: string;
  username: string;
  email: string;
  phoneNumber?: string;
  role: 'superadmin' | 'admin' | 'operator' | 'viewer';
  isActive: boolean;
  lastLogin?: string;
  createdAt: string;
  createdBy?: string;
  permissions?: string[];
}

const AdminManagement: React.FC = () => {
  const [admins, setAdmins] = useState<Admin[]>([
    {
      admin_id: 'adm_001',
      username: 'admin',
      email: 'admin@hualientaxi.com',
      phoneNumber: '0912345678',
      role: 'superadmin',
      isActive: true,
      lastLogin: '2025-11-12 10:30:00',
      createdAt: '2025-01-01 00:00:00',
      permissions: ['all'],
    },
    {
      admin_id: 'adm_002',
      username: 'manager',
      email: 'manager@hualientaxi.com',
      phoneNumber: '0923456789',
      role: 'admin',
      isActive: true,
      lastLogin: '2025-11-12 09:15:00',
      createdAt: '2025-02-15 10:00:00',
      createdBy: 'admin',
      permissions: ['drivers', 'passengers', 'orders', 'analytics'],
    },
    {
      admin_id: 'adm_003',
      username: 'operator',
      email: 'operator@hualientaxi.com',
      phoneNumber: '0934567890',
      role: 'operator',
      isActive: true,
      lastLogin: '2025-11-11 18:45:00',
      createdAt: '2025-03-20 14:30:00',
      createdBy: 'admin',
      permissions: ['orders', 'drivers'],
    },
    {
      admin_id: 'adm_004',
      username: 'viewer',
      email: 'viewer@hualientaxi.com',
      role: 'viewer',
      isActive: false,
      lastLogin: '2025-11-05 16:20:00',
      createdAt: '2025-04-10 11:00:00',
      createdBy: 'manager',
      permissions: ['analytics'],
    },
  ]);

  const [loading, setLoading] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [isDrawerVisible, setIsDrawerVisible] = useState(false);
  const [editingAdmin, setEditingAdmin] = useState<Admin | null>(null);
  const [selectedAdmin, setSelectedAdmin] = useState<Admin | null>(null);
  const [form] = Form.useForm();

  const handleAddAdmin = () => {
    setEditingAdmin(null);
    form.resetFields();
    setIsModalVisible(true);
  };

  const handleEditAdmin = (admin: Admin) => {
    setEditingAdmin(admin);
    form.setFieldsValue({
      ...admin,
      password: undefined, // 不要預填密碼
    });
    setIsModalVisible(true);
  };

  const handleViewAdmin = (admin: Admin) => {
    setSelectedAdmin(admin);
    setIsDrawerVisible(true);
  };

  const handleModalOk = async () => {
    try {
      const values = await form.validateFields();

      if (editingAdmin) {
        // 更新管理員
        setAdmins(admins.map(admin =>
          admin.admin_id === editingAdmin.admin_id
            ? { ...admin, ...values }
            : admin
        ));
        message.success('管理員資料更新成功！');
      } else {
        // 新增管理員
        const newAdmin: Admin = {
          admin_id: `adm_${Date.now()}`,
          ...values,
          isActive: true,
          createdAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
          createdBy: 'admin', // 應該從 auth context 獲取
        };
        setAdmins([...admins, newAdmin]);
        message.success('新增管理員成功！');
      }

      setIsModalVisible(false);
      form.resetFields();
    } catch (error) {
      message.error('操作失敗！');
    }
  };

  const handleToggleStatus = async (admin: Admin) => {
    setAdmins(admins.map(a =>
      a.admin_id === admin.admin_id
        ? { ...a, isActive: !a.isActive }
        : a
    ));
    message.success(`已${admin.isActive ? '停用' : '啟用'}管理員！`);
  };

  const handleDeleteAdmin = async (admin: Admin) => {
    setAdmins(admins.filter(a => a.admin_id !== admin.admin_id));
    message.success('刪除管理員成功！');
  };

  const handleResetPassword = async (admin: Admin) => {
    Modal.confirm({
      title: '重設密碼',
      content: `確定要重設管理員 ${admin.username} 的密碼嗎？系統將發送重設密碼連結到 ${admin.email}`,
      onOk: async () => {
        // TODO: 調用 API 重設密碼
        message.success('重設密碼郵件已發送！');
      },
    });
  };

  const getRoleTag = (role: string) => {
    const roleMap: { [key: string]: { color: string; text: string } } = {
      superadmin: { color: 'red', text: '超級管理員' },
      admin: { color: 'blue', text: '管理員' },
      operator: { color: 'green', text: '操作員' },
      viewer: { color: 'default', text: '檢視者' },
    };
    const config = roleMap[role] || { color: 'default', text: role };
    return <Tag color={config.color}>{config.text}</Tag>;
  };

  const columns = [
    {
      title: '管理員ID',
      dataIndex: 'admin_id',
      key: 'admin_id',
      width: 100,
      render: (id: string) => <span style={{ fontFamily: 'monospace' }}>{id}</span>,
    },
    {
      title: '使用者名稱',
      dataIndex: 'username',
      key: 'username',
      render: (username: string) => <strong>{username}</strong>,
    },
    {
      title: 'Email',
      dataIndex: 'email',
      key: 'email',
      render: (email: string) => (
        <Space>
          <MailOutlined />
          {email}
        </Space>
      ),
    },
    {
      title: '電話',
      dataIndex: 'phoneNumber',
      key: 'phoneNumber',
      render: (phone: string) => phone ? (
        <Space>
          <PhoneOutlined />
          {phone}
        </Space>
      ) : '-',
    },
    {
      title: '角色',
      dataIndex: 'role',
      key: 'role',
      render: (role: string) => getRoleTag(role),
    },
    {
      title: '狀態',
      dataIndex: 'isActive',
      key: 'isActive',
      render: (isActive: boolean) => (
        <Tag color={isActive ? 'success' : 'error'}>
          {isActive ? '啟用' : '停用'}
        </Tag>
      ),
    },
    {
      title: '最後登入',
      dataIndex: 'lastLogin',
      key: 'lastLogin',
      render: (time: string) => time ? dayjs(time).format('MM/DD HH:mm') : '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 280,
      render: (_: any, record: Admin) => (
        <Space size="small">
          <Button
            size="small"
            icon={<EyeOutlined />}
            onClick={() => handleViewAdmin(record)}
          />
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => handleEditAdmin(record)}
          />
          <Button
            size="small"
            icon={<KeyOutlined />}
            onClick={() => handleResetPassword(record)}
          >
            重設密碼
          </Button>
          <Switch
            size="small"
            checked={record.isActive}
            onChange={() => handleToggleStatus(record)}
            checkedChildren="啟用"
            unCheckedChildren="停用"
          />
          {record.role !== 'superadmin' && (
            <Popconfirm
              title="確定要刪除此管理員嗎？"
              onConfirm={() => handleDeleteAdmin(record)}
              okText="確定"
              cancelText="取消"
            >
              <Button
                size="small"
                icon={<DeleteOutlined />}
                danger
              />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Card>
        <Row gutter={16} style={{ marginBottom: 24 }}>
          <Col span={6}>
            <Card>
              <Statistic
                title="總管理員數"
                value={admins.length}
                prefix={<TeamOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="啟用中"
                value={admins.filter(a => a.isActive).length}
                valueStyle={{ color: '#3f8600' }}
                prefix={<UserOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="超級管理員"
                value={admins.filter(a => a.role === 'superadmin').length}
                valueStyle={{ color: '#cf1322' }}
                prefix={<TeamOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="停用"
                value={admins.filter(a => !a.isActive).length}
                valueStyle={{ color: '#8c8c8c' }}
                prefix={<LockOutlined />}
              />
            </Card>
          </Col>
        </Row>

        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between' }}>
          <Title level={3} style={{ margin: 0 }}>管理員列表</Title>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => setLoading(true)}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAddAdmin}>
              新增管理員
            </Button>
          </Space>
        </div>

        <Table
          columns={columns}
          dataSource={admins}
          rowKey="admin_id"
          loading={loading}
          pagination={{
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 筆`,
          }}
        />
      </Card>

      {/* 新增/編輯管理員 Modal */}
      <Modal
        title={editingAdmin ? '編輯管理員' : '新增管理員'}
        visible={isModalVisible}
        onOk={handleModalOk}
        onCancel={() => {
          setIsModalVisible(false);
          form.resetFields();
        }}
        width={600}
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label="使用者名稱"
                name="username"
                rules={[
                  { required: true, message: '請輸入使用者名稱' },
                  { min: 3, message: '至少3個字元' },
                ]}
              >
                <Input prefix={<UserOutlined />} placeholder="使用者名稱" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="Email"
                name="email"
                rules={[
                  { required: true, message: '請輸入Email' },
                  { type: 'email', message: '請輸入有效的Email' },
                ]}
              >
                <Input prefix={<MailOutlined />} placeholder="email@example.com" />
              </Form.Item>
            </Col>
          </Row>

          {!editingAdmin && (
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label="密碼"
                  name="password"
                  rules={[
                    { required: true, message: '請輸入密碼' },
                    { min: 6, message: '密碼至少6個字元' },
                  ]}
                >
                  <Input.Password prefix={<KeyOutlined />} placeholder="密碼" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label="確認密碼"
                  name="confirmPassword"
                  dependencies={['password']}
                  rules={[
                    { required: true, message: '請確認密碼' },
                    ({ getFieldValue }) => ({
                      validator(_, value) {
                        if (!value || getFieldValue('password') === value) {
                          return Promise.resolve();
                        }
                        return Promise.reject(new Error('兩次密碼輸入不一致！'));
                      },
                    }),
                  ]}
                >
                  <Input.Password prefix={<KeyOutlined />} placeholder="確認密碼" />
                </Form.Item>
              </Col>
            </Row>
          )}

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label="電話號碼"
                name="phoneNumber"
                rules={[
                  { pattern: /^09\d{8}$/, message: '請輸入有效的手機號碼' },
                ]}
              >
                <Input prefix={<PhoneOutlined />} placeholder="09xxxxxxxx" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="角色"
                name="role"
                rules={[{ required: true, message: '請選擇角色' }]}
              >
                <Select placeholder="請選擇角色">
                  <Option value="admin">管理員</Option>
                  <Option value="operator">操作員</Option>
                  <Option value="viewer">檢視者</Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            label="權限"
            name="permissions"
            rules={[{ required: true, message: '請選擇至少一個權限' }]}
          >
            <Select mode="multiple" placeholder="請選擇權限">
              <Option value="dashboard">儀表板</Option>
              <Option value="drivers">司機管理</Option>
              <Option value="passengers">乘客管理</Option>
              <Option value="orders">訂單管理</Option>
              <Option value="analytics">數據分析</Option>
              <Option value="admins">管理員設定</Option>
              <Option value="settings">系統設定</Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      {/* 管理員詳情 Drawer */}
      <Drawer
        title="管理員詳細資料"
        width={600}
        visible={isDrawerVisible}
        onClose={() => setIsDrawerVisible(false)}
      >
        {selectedAdmin && (
          <div>
            <Descriptions title="基本資料" bordered column={1}>
              <Descriptions.Item label="管理員ID">{selectedAdmin.admin_id}</Descriptions.Item>
              <Descriptions.Item label="使用者名稱">{selectedAdmin.username}</Descriptions.Item>
              <Descriptions.Item label="Email">{selectedAdmin.email}</Descriptions.Item>
              <Descriptions.Item label="電話">
                {selectedAdmin.phoneNumber || '未提供'}
              </Descriptions.Item>
              <Descriptions.Item label="角色">
                {getRoleTag(selectedAdmin.role)}
              </Descriptions.Item>
              <Descriptions.Item label="狀態">
                <Tag color={selectedAdmin.isActive ? 'success' : 'error'}>
                  {selectedAdmin.isActive ? '啟用' : '停用'}
                </Tag>
              </Descriptions.Item>
            </Descriptions>

            <Descriptions title="權限設定" bordered column={1} style={{ marginTop: 24 }}>
              <Descriptions.Item label="擁有權限">
                <Space wrap>
                  {selectedAdmin.permissions?.map(perm => (
                    <Tag key={perm} color="blue">{perm}</Tag>
                  ))}
                </Space>
              </Descriptions.Item>
            </Descriptions>

            <Descriptions title="帳號資訊" bordered column={1} style={{ marginTop: 24 }}>
              <Descriptions.Item label="建立時間">
                {selectedAdmin.createdAt}
              </Descriptions.Item>
              <Descriptions.Item label="建立者">
                {selectedAdmin.createdBy || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="最後登入">
                {selectedAdmin.lastLogin || '尚未登入'}
              </Descriptions.Item>
            </Descriptions>

            <div style={{ marginTop: 24 }}>
              <Title level={5}>操作記錄</Title>
              <Table
                dataSource={[
                  {
                    key: '1',
                    action: '登入系統',
                    time: '2025-11-12 10:30:00',
                    ip: '192.168.1.100',
                  },
                  {
                    key: '2',
                    action: '更新司機資料',
                    time: '2025-11-12 10:25:00',
                    ip: '192.168.1.100',
                  },
                  {
                    key: '3',
                    action: '查看訂單詳情',
                    time: '2025-11-12 10:15:00',
                    ip: '192.168.1.100',
                  },
                ]}
                columns={[
                  { title: '操作', dataIndex: 'action' },
                  { title: '時間', dataIndex: 'time' },
                  { title: 'IP', dataIndex: 'ip' },
                ]}
                pagination={false}
                size="small"
              />
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
};

export default AdminManagement;
