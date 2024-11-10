import React, { useState } from 'react';
import { MessageSquare, Share2, Trophy, ThumbsUp, Users } from 'lucide-react';

interface User {
    id: string;
    username: string;
    avatar: string;
    ranking: number;
    accuracy: number;
    successStreak: number;
    predictions: number;
}

interface Comment {
    id: string;
    userId: string;
    username: string;
    avatar: string;
    content: string;
    timestamp: string;
    likes: number;
    isLiked: boolean;
}

const SocialHub: React.FC = () => {
    const [activeTab, setActiveTab] = useState<'ranking'|'discussion'>('ranking');
    const [comments, setComments] = useState<Comment[]>([
        {
            id: '1',
            userId: 'user1',
            username: 'PredictorPro',
            avatar: '/avatars/1.png',
            content: 'Il City ha un trend positivo nelle ultime 5 partite casalinghe contro l\'Arsenal',
            timestamp: '2m fa',
            likes: 12,
            isLiked: false
        },
        {
            id: '2',
            userId: 'user2',
            username: 'StatisticsMaster',
            avatar: '/avatars/2.png',
            content: 'Attenzione all\'Over, entrambe le squadre hanno segnato negli ultimi 4 scontri diretti',
            timestamp: '5m fa',
            likes: 8,
            isLiked: true
        }
    ]);

    const topUsers: User[] = [
        {
            id: '1',
            username: 'ProPredictor',
            avatar: '/avatars/3.png',
            ranking: 1,
            accuracy: 78.5,
            successStreak: 5,
            predictions: 234
        },
        {
            id: '2',
            username: 'BettingKing',
            avatar: '/avatars/4.png',
            ranking: 2,
            accuracy: 76.2,
            successStreak: 3,
            predictions: 189
        }
    ];

    const handleComment = (content: string) => {
        const newComment: Comment = {
            id: Date.now().toString(),
            userId: 'currentUser',
            username: 'You',
            avatar: '/avatars/default.png',
            content,
            timestamp: 'Ora',
            likes: 0,
            isLiked: false
        };
        setComments([newComment, ...comments]);
    };

    const handleLike = (commentId: string) => {
        setComments(comments.map(comment => {
            if (comment.id === commentId) {
                return {
                    ...comment,
                    likes: comment.isLiked ? comment.likes - 1 : comment.likes + 1,
                    isLiked: !comment.isLiked
                };
            }
            return comment;
        }));
    };

    return (
        <div className="flex flex-col h-screen bg-gray-50">
            {/* Header */}
            <div className="bg-white px-4 py-3 shadow-sm">
                <h1 className="text-lg font-bold">Community</h1>
                <div className="flex gap-4 mt-2">
                    <button
                        className={`flex items-center gap-2 px-3 py-1 rounded-full text-sm ${
                            activeTab === 'ranking' 
                                ? 'bg-blue-100 text-blue-600' 
                                : 'text-gray-600'
                        }`}
                        onClick={() => setActiveTab('ranking')}
                    >
                        <Trophy size={16} />
                        Classifica
                    </button>
                    <button
                        className={`flex items-center gap-2 px-3 py-1 rounded-full text-sm ${
                            activeTab === 'discussion' 
                                ? 'bg-blue-100 text-blue-600' 
                                : 'text-gray-600'
                        }`}
                        onClick={() => setActiveTab('discussion')}
                    >
                        <MessageSquare size={16} />
                        Discussione
                    </button>
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4">
                {activeTab === 'ranking' ? (
                    <div className="space-y-4">
                        {/* Top Users */}
                        {topUsers.map((user, index) => (
                            <div key={user.id} className="bg-white rounded-lg p-4 shadow-sm">
                                <div className="flex items-center gap-4">
                                    <div className="relative">
                                        <img 
                                            src={user.avatar} 
                                            alt={user.username}
                                            className="w-12 h-12 rounded-full"
                                        />
                                        <span className={`absolute -top-1 -right-1 w-6 h-6 flex items-center justify-center rounded-full text-xs font-bold ${
                                            index === 0 ? 'bg-yellow-400 text-white' :
                                            index === 1 ? 'bg-gray-300 text-gray-700' :
                                            'bg-bronze text-white'
                                        }`}>
                                            {user.ranking}
                                        </span>
                                    </div>
                                    <div className="flex-1">
                                        <div className="font-semibold">{user.username}</div>
                                        <div className="text-sm text-gray-500">
                                            Accuratezza: {user.accuracy}%
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <div className="text-sm font-medium text-green-600">
                                            +{user.successStreak} streak
                                        </div>
                                        <div className="text-xs text-gray-500">
                                            {user.predictions} predizioni
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="space-y-4">
                        {/* Comment Input */}
                        <div className="bg-white rounded-lg p-4 shadow-sm">
                            <textarea
                                placeholder="Condividi la tua analisi..."
                                className="w-full p-2 border rounded-lg text-sm"
                                rows={3}
                            />
                            <div className="flex justify-end mt-2">
                                <button className="bg-blue-600 text-white px-4 py-1 rounded-full text-sm">
                                    Commenta
                                </button>
                            </div>
                        </div>

                        {/* Comments */}
                        {comments.map(comment => (
                            <div key={comment.id} className="bg-white rounded-lg p-4 shadow-sm">
                                <div className="flex items-start gap-3">
                                    <img 
                                        src={comment.avatar} 
                                        alt={comment.username}
                                        className="w-8 h-8 rounded-full"
                                    />
                                    <div className="flex-1">
                                        <div className="flex items-center gap-2">
                                            <span className="font-medium">{comment.username}</span>
                                            <span className="text-xs text-gray-500">{comment.timestamp}</span>
                                        </div>
                                        <p className="text-sm mt-1">{comment.content}</p>
                                        <div className="flex items-center gap-4 mt-2">
                                            <button
                                                className={`flex items-center gap-1 text-sm ${
                                                    comment.isLiked ? 'text-blue-600' : 'text-gray-500'
                                                }`}
                                                onClick={() => handleLike(comment.id)}
                                            >
                                                <ThumbsUp size={14} />
                                                {comment.likes}
                                            </button>
                                            <button className="text-sm text-gray-500 flex items-center gap-1">
                                                <MessageSquare size={14} />
                                                Rispondi
                                            </button>
                                            <button className="text-sm text-gray-500 flex items-center gap-1">
                                                <Share2 size={14} />
                                                Condividi
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Active Users */}
            <div className="bg-white border-t px-4 py-2 flex items-center gap-2">
                <Users size={16} className="text-gray-500" />
                <span className="text-sm text-gray-600">128 utenti attivi</span>
            </div>
        </div>
    );
};

export default SocialHub;