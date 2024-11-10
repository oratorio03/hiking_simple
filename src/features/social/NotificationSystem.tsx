import React, { useState } from 'react';
import { Bell, CheckCircle, AlertTriangle, MessageSquare, Trophy } from 'lucide-react';

interface Notification {
    id: string;
    type: 'prediction' | 'social' | 'achievement';
    title: string;
    message: string;
    timestamp: string;
    read: boolean;
    actionUrl?: string;
    icon?: React.ReactNode;
}

const NotificationSystem: React.FC = () => {
    const [notifications, setNotifications] = useState<Notification[]>([
        {
            id: '1',
            type: 'prediction',
            title: 'Predizione Corretta!',
            message: 'La tua predizione Man City - Arsenal (2-1) era corretta',
            timestamp: '2m fa',
            read: false,
            icon: <CheckCircle className="text-green-500" />
        },
        {
            id: '2',
            type: 'social',
            title: 'Nuovo Commento',
            message: 'BettingPro ha risposto alla tua analisi',
            timestamp: '5m fa',
            read: false,
            icon: <MessageSquare className="text-blue-500" />
        },
        {
            id: '3',
            type: 'achievement',
            title: 'Nuovo Achievement!',
            message: 'Hai raggiunto 5 predizioni corrette consecutive',
            timestamp: '1h fa',
            read: true,
            icon: <Trophy className="text-yellow-500" />
        }
    ]);

    const [filter, setFilter] = useState<'all' | 'unread'>('all');

    const markAsRead = (notificationId: string) => {
        setNotifications(notifications.map(notif => 
            notif.id === notificationId ? { ...notif, read: true } : notif
        ));
    };

    const markAllAsRead = () => {
        setNotifications(notifications.map(notif => ({ ...notif, read: true })));
    };

    const filteredNotifications = filter === 'all' 
        ? notifications 
        : notifications.filter(n => !n.read);

    const unreadCount = notifications.filter(n => !n.read).length;

    return (
        <div className="flex flex-col h-screen bg-gray-50">
            {/* Header */}
            <div className="bg-white px-4 py-3 shadow-sm">
                <div className="flex items-center justify-between">
                    <h1 className="text-lg font-bold">Notifiche</h1>
                    <div className="relative">
                        <Bell size={20} />
                        {unreadCount > 0 && (
                            <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs w-4 h-4 flex items-center justify-center rounded-full">
                                {unreadCount}
                            </span>
                        )}
                    </div>
                </div>

                {/* Filters */}
                <div className="flex gap-2 mt-2">
                    <button
                        className={`px-3 py-1 rounded-full text-sm ${
                            filter === 'all' 
                                ? 'bg-blue-100 text-blue-600' 
                                : 'text-gray-600'
                        }`}
                        onClick={() => setFilter('all')}
                    >
                        Tutte
                    </button>
                    <button
                        className={`px-3 py-1 rounded-full text-sm ${
                            filter === 'unread' 
                                ? 'bg-blue-100 text-blue-600' 
                                : 'text-gray-600'
                        }`}
                        onClick={() => setFilter('unread')}
                    >
                        Non lette
                    </button>
                    {unreadCount > 0 && (
                        <button
                            className="ml-auto text-sm text-blue-600"
                            onClick={markAllAsRead}
                        >
                            Segna tutte come lette
                        </button>
                    )}
                </div>
            </div>

            {/* Notifications List */}
            <div className="flex-1 overflow-y-auto">
                {filteredNotifications.map(notification => (
                    <div 
                        key={notification.id}
                        className={`p-4 border-b ${
                            notification.read ? 'bg-white' : 'bg-blue-50'
                        }`}
                        onClick={() => markAsRead(notification.id)}
                    >
                        <div className="flex gap-3">
                            <div className="mt-1">
                                {notification.icon}
                            </div>
                            <div className="flex-1">
                                <div className="font-medium">{notification.title}</div>
                                <p className="text-sm text-gray-600 mt-1">
                                    {notification.message}
                                </p>
                                <div className="flex items-center gap-2 mt-2">
                                    <span className="text-xs text-gray-500">
                                        {notification.timestamp}
                                    </span