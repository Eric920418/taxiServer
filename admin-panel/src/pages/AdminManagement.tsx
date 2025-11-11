import React from 'react';
import { Card, Typography } from 'antd';

const { Title } = Typography;

const AdminManagement: React.FC = () => {
  return (
    <div>
      <Card>
        <Title level={2}>管理員設定</Title>
        <p>管理員管理功能開發中...</p>
      </Card>
    </div>
  );
};

export default AdminManagement;