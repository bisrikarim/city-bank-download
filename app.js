// City Bank - Application Logic with Supabase + Authentication

import { supabase } from './supabase-config.js';

// ==================== Authentication Management ====================

class AuthManager {
    constructor() {
        this.user = null;
        this.profile = null;
        this.isAdmin = false;
        this.listeners = [];
    }

    async init() {
        // Vérifier la session existante
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) {
            this.user = session.user;
            await this.loadUserProfile(session.user.id);
        }

        // Écouter les changements d'auth
        supabase.auth.onAuthStateChange(async (event, session) => {
            if (session?.user) {
                this.user = session.user;
                await this.loadUserProfile(session.user.id);
            } else {
                this.user = null;
                this.profile = null;
                this.isAdmin = false;
            }
            this.notifyListeners();
        });
    }

    async loadUserProfile(userId) {
        this.user = (await supabase.auth.getUser()).data.user;
        
        // Charger le profil
        const { data: profile, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .single();

        if (!error && profile) {
            this.profile = profile;
            this.isAdmin = profile.role === 'admin';
        }
    }

    async signUp(email, password, displayName) {
        try {
            const { data, error } = await supabase.auth.signUp({
                email,
                password,
                options: {
                    data: {
                        display_name: displayName
                    }
                }
            });

            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async signIn(email, password) {
        try {
            const { data, error } = await supabase.auth.signInWithPassword({
                email,
                password
            });

            if (error) throw error;
            await this.loadUserProfile(data.user.id);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async signOut() {
        try {
            const { error } = await supabase.auth.signOut();
            if (error) throw error;
            this.user = null;
            this.profile = null;
            this.isAdmin = false;
            this.notifyListeners();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    isAuthenticated() {
        return this.user !== null;
    }

    getUserId() {
        return this.user?.id;
    }

    onAuthChange(callback) {
        this.listeners.push(callback);
    }

    notifyListeners() {
        this.listeners.forEach(callback => callback(this.user, this.isAdmin));
    }
}

// ==================== Data Management ====================

class MessageManager {
    constructor(authManager) {
        this.authManager = authManager;
        this.conversations = [];
        this.unreadCount = 0;
        this.subscription = null;
    }

    async init() {
        await this.loadConversations();
        await this.loadUnreadCount();
        this.setupRealtimeSubscription();
    }

    async loadConversations() {
        try {
            const userId = this.authManager.getUserId();
            if (!userId) return;

            const { data, error } = await supabase
                .from('conversations')
                .select(`
                    *,
                    ad:ads(id, title, images_paths),
                    buyer:buyer_id(display_name),
                    seller:seller_id(display_name),
                    messages(content, created_at, sender_id, read_at)
                `)
                .or(`buyer_id.eq.${userId},seller_id.eq.${userId}`)
                .order('updated_at', { ascending: false });

            if (error) throw error;

            this.conversations = (data || []).map(conv => ({
                ...conv,
                lastMessage: conv.messages?.[conv.messages.length - 1] || null,
                unreadCount: this.getUnreadCountForConversation(conv, userId)
            }));

        } catch (error) {
            this.conversations = [];
        }
    }

    async loadUnreadCount() {
        try {
            const userId = this.authManager.getUserId();
            if (!userId) return;

            const { data, error } = await supabase
                .rpc('get_unread_message_count', { user_id: userId });

            if (error) throw error;
            this.unreadCount = data || 0;
        } catch (error) {
            this.unreadCount = 0;
        }
    }

    getUnreadCountForConversation(conversation, userId) {
        if (!conversation.messages) return 0;
        return conversation.messages.filter(msg => 
            msg.sender_id !== userId && !msg.read_at
        ).length;
    }

    async createConversation(adId, sellerId) {
        try {
            const userId = this.authManager.getUserId();
            if (!userId || userId === sellerId) return null;

            // Check if conversation already exists
            const existing = this.conversations.find(conv => 
                conv.ad_id === adId && conv.buyer_id === userId
            );
            if (existing) return existing;

            const { data, error } = await supabase
                .from('conversations')
                .insert({
                    ad_id: adId,
                    buyer_id: userId,
                    seller_id: sellerId
                })
                .select()
                .single();

            if (error) throw error;
            
            await this.loadConversations();
            return data;
        } catch (error) {
            throw error;
        }
    }

    async sendMessage(conversationId, content) {
        try {
            const userId = this.authManager.getUserId();
            if (!userId || !content.trim()) return null;

            const { data, error } = await supabase
                .from('messages')
                .insert({
                    conversation_id: conversationId,
                    sender_id: userId,
                    content: content.trim()
                })
                .select()
                .single();

            if (error) throw error;
            return data;
        } catch (error) {
            throw error;
        }
    }

    async loadMessages(conversationId) {
        try {
            const { data, error } = await supabase
                .from('messages')
                .select(`
                    *,
                    sender:sender_id(display_name)
                `)
                .eq('conversation_id', conversationId)
                .order('created_at', { ascending: true });

            if (error) throw error;
            return data || [];
        } catch (error) {
            return [];
        }
    }

    async markMessagesAsRead(conversationId) {
        try {
            const userId = this.authManager.getUserId();
            if (!userId) return;

            const { error } = await supabase
                .from('messages')
                .update({ read_at: new Date().toISOString() })
                .eq('conversation_id', conversationId)
                .neq('sender_id', userId)
                .is('read_at', null);

            if (error) throw error;
            await this.loadUnreadCount();
        } catch (error) {
            // Ignore errors for read receipts
        }
    }

    setupRealtimeSubscription() {
        const userId = this.authManager.getUserId();
        if (!userId) return;

        this.subscription = supabase
            .channel('messages_changes')
            .on('postgres_changes', 
                { event: 'INSERT', schema: 'public', table: 'messages' },
                async (payload) => {
                    // Reload conversations when new message arrives
                    await this.loadConversations();
                    await this.loadUnreadCount();
                    
                    // Notify UI manager if available
                    if (window.uiManager) {
                        window.uiManager.handleNewMessage(payload.new);
                    }
                }
            )
            .subscribe();
    }

    getConversation(conversationId) {
        return this.conversations.find(conv => conv.id === conversationId);
    }

    destroy() {
        if (this.subscription) {
            supabase.removeChannel(this.subscription);
        }
    }
}

class AdManager {
    constructor(authManager) {
        this.authManager = authManager;
        this.ads = [];
        this.subscription = null;
    }

    async init() {
        await this.loadAds();
        
        // Écoute en temps réel des changements
        this.subscription = supabase
            .channel('ads_changes')
            .on('postgres_changes', 
                { event: '*', schema: 'public', table: 'ads' },
                async () => {
                    await this.loadAds();
                    if (window.uiManager) {
                        window.uiManager.renderAds();
                    }
                }
            )
            .subscribe();
    }

    async loadAds() {
        try {
            // Charge seulement les annonces approuvées pour l'affichage public
            // Les admins verront toutes les annonces via une fonction séparée
            const { data, error } = await supabase
                .from('ads')
                .select('*')
                .eq('status', 'approved')
                .order('created_at', { ascending: false });
            
            if (error) {
                throw error;
            }
            
            // Générer URLs signées pour les images des annonces approuvées
            this.ads = await Promise.all((data || []).map(async ad => {
                const images = await this.getSignedImageUrls(ad.images_paths || []);
                
                return {
                    ...ad,
                    id: ad.id,
                    createdAt: ad.created_at || new Date().toISOString(),
                    images
                };
            }));
        } catch (error) {
            this.ads = []; // Éviter les erreurs d'affichage
        }
    }

    async loadPendingAds() {
        try {
            const { data, error } = await supabase
                .from('ads')
                .select('*, profiles:user_id(display_name)')
                .eq('status', 'pending')
                .order('created_at', { ascending: false });
            
            if (error) throw error;
            
            // Générer URLs signées pour les images
            return await Promise.all((data || []).map(async ad => ({
                ...ad,
                id: ad.id,
                createdAt: ad.created_at || new Date().toISOString(),
                images: await this.getSignedImageUrls(ad.images_paths || [])
            })));
        } catch (error) {
            return [];
        }
    }

    async getSignedImageUrls(imagePaths) {
        if (!imagePaths || imagePaths.length === 0) return [];
        
        const signedUrls = await Promise.all(
            imagePaths.map(async (path) => {
                const { data, error } = await supabase.storage
                    .from('ads')
                    .createSignedUrl(path, 3600); // URL valide 1 heure
                
                if (error) {
                    return null;
                }
                
                return data.signedUrl;
            })
        );
        
        return signedUrls.filter(url => url !== null);
    }

    async addAd(ad) {
        try {
            const userId = this.authManager.getUserId();
            if (!userId) throw new Error('Utilisateur non connecté');

            const { data, error } = await supabase
                .from('ads')
                .insert({
                    user_id: userId,
                    title: ad.title,
                    description: ad.description,
                    phone: ad.phone,
                    category: ad.category || 'autre',
                    images_paths: ad.images_paths || [],
                    status: 'pending',
                    item_status: 'available'
                })
                .select()
                .single();
            
            if (error) {
                throw error;
            }
            return data;
        } catch (error) {
            throw error;
        }
    }

    async updateAdStatus(id, status, reviewedBy) {
        try {
            const { data, error } = await supabase
                .from('ads')
                .update({
                    status,
                    reviewed_by: reviewedBy,
                    reviewed_at: new Date().toISOString()
                })
                .eq('id', id)
                .select()
                .single();
            
            if (error) throw error;
            return data;
        } catch (error) {
            throw error;
        }
    }

    async updateItemStatus(id, itemStatus) {
        try {
            const userId = this.authManager.getUserId();
            
            if (!userId) throw new Error('Utilisateur non connecté');

            // Check if the ad exists and get its owner
            const { data: adCheck, error: checkError } = await supabase
                .from('ads')
                .select('id, user_id, title, item_status')
                .eq('id', id)
                .single();
            
            if (checkError) {
                throw new Error('Annonce introuvable');
            }
            
            if (adCheck.user_id !== userId) {
                throw new Error('Vous n\'êtes pas le propriétaire de cette annonce');
            }
            
            const { data, error } = await supabase
                .from('ads')
                .update({
                    item_status: itemStatus
                })
                .eq('id', id)
                .eq('user_id', userId) // Only owner can update
                .select();
            
            if (error) throw error;
            
            if (!data || data.length === 0) {
                throw new Error('Impossible de mettre à jour le statut. Vérifiez vos permissions.');
            }
            
            // Update local ads array
            const adIndex = this.ads.findIndex(ad => ad.id === id);
            
            if (adIndex !== -1) {
                this.ads[adIndex].item_status = itemStatus;
            }
            
            return data[0]; // Return first (and only) updated record
        } catch (error) {
            throw error;
        }
    }

    async deleteAd(id) {
        try {
            // Supprimer les images du Storage
            const ad = this.ads.find(a => a.id === id);
            if (ad && ad.images_paths) {
                await this.deleteImages(ad.images_paths);
            }

            const { error } = await supabase
                .from('ads')
                .delete()
                .eq('id', id);
            
            if (error) throw error;
        } catch (error) {
            throw error;
        }
    }

    async deleteImages(imagePaths) {
        const deletePromises = imagePaths.map(path => 
            supabase.storage.from('ads').remove([path])
        );
        await Promise.all(deletePromises);
    }

    getAd(id) {
        return this.ads.find(ad => ad.id === id);
    }

    searchAds(query, category = 'all') {
        let filteredAds = this.ads;
        
        // Filter by category first
        if (category && category !== 'all') {
            filteredAds = filteredAds.filter(ad => ad.category === category);
        }
        
        // Then filter by search query
        if (query) {
            const lowerQuery = query.toLowerCase();
            filteredAds = filteredAds.filter(ad => 
                ad.title.toLowerCase().includes(lowerQuery) ||
                ad.description.toLowerCase().includes(lowerQuery)
            );
        }
        
        return filteredAds;
    }

    filterByCategory(category) {
        if (category === 'all') {
            return this.ads;
        }
        return this.ads.filter(ad => ad.category === category);
    }

    async uploadImages(files) {
        const userId = this.authManager.getUserId();
        if (!userId) throw new Error('Utilisateur non connecté');

        const uploadPromises = files.map(async (file) => {
            const timestamp = Date.now();
            const fileExt = file.name.split('.').pop().toLowerCase();
            const fileName = `${timestamp}_${Math.random().toString(36).substring(7)}.${fileExt}`;
            const filePath = `${userId}/${fileName}`;
            
            // Upload vers Supabase Storage (bucket privé)
            const uploadOptions = {
                cacheControl: '3600',
                upsert: false
            };
            
            // Seulement si le type est valide et différent de jpeg (problème connu)
            if (file.type && file.type !== 'image/jpeg') {
                uploadOptions.contentType = file.type;
            }
            
            const { data, error } = await supabase.storage
                .from('ads')
                .upload(filePath, file, uploadOptions);
            
            if (error) {
                throw error;
            }
            
            return data.path;
        });

        return await Promise.all(uploadPromises);
    }

    destroy() {
        if (this.subscription) {
            supabase.removeChannel(this.subscription);
        }
    }
}

// ==================== UI Management ====================

class UIManager {
    constructor(adManager, authManager, messageManager) {
        this.adManager = adManager;
        this.authManager = authManager;
        this.messageManager = messageManager;
        this.currentImages = [];
        this.currentImageFiles = [];
        this.isUploading = false;
        this.currentCategory = 'all';
        this.currentSearchQuery = '';
        this.currentOpenConversation = null;
        this.init();
    }

    async init() {
        this.setupEventListeners();
        await this.adManager.init();
        this.renderAds();
        this.updateAuthUI();
        
        // Écouter les changements d'auth
        this.authManager.onAuthChange(async (user, isAdmin) => {
            this.updateAuthUI();
            this.renderAds();
            
            // Initialize or destroy messaging based on auth state
            if (user && this.messageManager) {
                await this.messageManager.init();
            } else if (this.messageManager) {
                this.messageManager.destroy();
            }
        });
    }

    setupEventListeners() {
        // Auth buttons
        const btnLogin = document.getElementById('btnLogin');
        const btnLogout = document.getElementById('btnLogout');
        const btnNewAd = document.getElementById('btnNewAd');
        const btnMessages = document.getElementById('btnMessages');
        const btnAdmin = document.getElementById('btnAdmin');

        if (btnLogin) {
            btnLogin.replaceWith(btnLogin.cloneNode(true));
            document.getElementById('btnLogin').addEventListener('click', () => this.openAuthModal('login'));
        }

        if (btnLogout) {
            btnLogout.replaceWith(btnLogout.cloneNode(true));
            document.getElementById('btnLogout').addEventListener('click', () => this.handleLogout());
        }

        if (btnNewAd) {
            btnNewAd.replaceWith(btnNewAd.cloneNode(true));
            document.getElementById('btnNewAd').addEventListener('click', () => {
                if (this.authManager.isAuthenticated()) {
                    this.openModal();
                } else {
                    this.openAuthModal('login');
                }
            });
        }

        if (btnMessages) {
            btnMessages.replaceWith(btnMessages.cloneNode(true));
            document.getElementById('btnMessages').addEventListener('click', () => this.openMessagesModal());
        }

        if (btnAdmin) {
            btnAdmin.replaceWith(btnAdmin.cloneNode(true));
            document.getElementById('btnAdmin').addEventListener('click', () => this.openAdminModal());
        }

        // Search functionality
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));
        }

        // Category filter buttons
        const categoryButtons = document.querySelectorAll('.category-btn');
        categoryButtons.forEach(btn => {
            btn.addEventListener('click', (e) => this.handleCategoryFilter(e.target.dataset.category));
        });
    }

    updateAuthUI() {
        const btnLogin = document.getElementById('btnLogin');
        const btnLogout = document.getElementById('btnLogout');
        const btnNewAd = document.getElementById('btnNewAd');
        const btnMessages = document.getElementById('btnMessages');
        const btnAdmin = document.getElementById('btnAdmin');

        const isAuth = this.authManager.isAuthenticated();
        const isAdmin = this.authManager.isAdmin;

        if (btnLogin) btnLogin.style.display = isAuth ? 'none' : 'inline-flex';
        if (btnLogout) btnLogout.style.display = isAuth ? 'inline-flex' : 'none';
        if (btnNewAd) btnNewAd.style.display = isAuth ? 'inline-flex' : 'none';
        if (btnMessages) btnMessages.style.display = isAuth ? 'inline-flex' : 'none';
        if (btnAdmin) btnAdmin.style.display = (isAuth && isAdmin) ? 'inline-flex' : 'none';

        // Update unread message count
        if (isAuth && this.messageManager) {
            this.updateUnreadBadge();
        }
    }

    async handleLogout() {
        if (confirm('Êtes-vous sûr de vouloir vous déconnecter ?')) {
            await this.authManager.signOut();
            this.showNotification('Vous êtes déconnecté.');
        }
    }

    handleSearch(query) {
        this.currentSearchQuery = query;
        const results = this.adManager.searchAds(query, this.currentCategory);
        this.renderAds(results);
    }

    handleCategoryFilter(category) {
        this.currentCategory = category;
        
        // Update active button
        document.querySelectorAll('.category-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        document.querySelector(`[data-category="${category}"]`).classList.add('active');
        
        // Apply filters
        const results = this.adManager.searchAds(this.currentSearchQuery, category);
        this.renderAds(results);
    }

    renderAds(ads = null) {
        const adsToRender = ads || this.adManager.ads;
        const adsGrid = document.getElementById('adsGrid');
        const emptyState = document.getElementById('emptyState');
        const itemCount = document.getElementById('itemCount');

        const count = adsToRender.length;
        itemCount.textContent = `${count} article${count > 1 ? 's' : ''} disponible${count > 1 ? 's' : ''}`;

        if (adsToRender.length === 0) {
            adsGrid.style.display = 'none';
            emptyState.classList.add('active');
            return;
        }

        adsGrid.style.display = 'grid';
        emptyState.classList.remove('active');

        adsGrid.innerHTML = adsToRender.map(ad => this.createAdCard(ad)).join('');

        adsGrid.querySelectorAll('.ad-card').forEach(card => {
            card.addEventListener('click', () => {
                const adId = card.dataset.id;
                this.showAdDetail(adId);
            });
        });
    }

    createAdCard(ad) {
        const imageUrl = ad.images && ad.images.length > 0 ? ad.images[0] : '';
        const date = this.formatDate(ad.createdAt);
        const statusBadge = this.createStatusBadge(ad.item_status || 'available');
        
        return `
            <div class="ad-card" data-id="${ad.id}">
                ${imageUrl ? `<img src="${imageUrl}" alt="${ad.title}" class="ad-image">` : '<div class="ad-image"></div>'}
                ${statusBadge}
                <div class="ad-content">
                    <h3 class="ad-title">${this.escapeHtml(ad.title)}</h3>
                    <p class="ad-description">${this.escapeHtml(ad.description)}</p>
                    <div class="ad-footer">
                        <span class="ad-date">
                            <svg class="ad-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                                <line x1="16" y1="2" x2="16" y2="6"></line>
                                <line x1="8" y1="2" x2="8" y2="6"></line>
                                <line x1="3" y1="10" x2="21" y2="10"></line>
                            </svg>
                            ${date}
                        </span>
                        <span class="ad-contact">
                            <svg class="ad-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"></path>
                            </svg>
                            ${this.formatPhone(ad.phone)}
                        </span>
                    </div>
                </div>
            </div>
        `;
    }

    createStatusBadge(itemStatus) {
        const statusConfig = {
            'available': {
                text: 'Disponible',
                class: 'status-available',
                icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 12l2 2 4-4"></path>
                    <circle cx="12" cy="12" r="10"></circle>
                </svg>`
            },
            'reserved': {
                text: 'Réservé',
                class: 'status-reserved',
                icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <path d="M12 6v6l4 2"></path>
                </svg>`
            },
            'given_away': {
                text: 'Donné',
                class: 'status-given-away',
                icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M20 6L9 17l-5-5"></path>
                </svg>`
            }
        };

        const config = statusConfig[itemStatus] || statusConfig['available'];
        return `
            <div class="status-badge ${config.class}">
                ${config.icon}
                <span>${config.text}</span>
            </div>
        `;
    }

    openAuthModal(mode = 'login') {
        const modal = document.getElementById('authModal');
        const modalTitle = document.getElementById('authModalTitle');
        const modalBody = document.getElementById('authModalBody');

        modalTitle.textContent = mode === 'login' ? 'Connexion' : 'Inscription';
        modalBody.innerHTML = this.createAuthForm(mode);

        modal.classList.add('active');
        document.body.style.overflow = 'hidden';

        this.setupAuthFormListeners(mode);
    }

    createAuthForm(mode) {
        const isLogin = mode === 'login';
        return `
            <form id="authForm">
                ${!isLogin ? `
                    <div class="form-group">
                        <label for="displayNameInput">Nom d'affichage</label>
                        <input type="text" id="displayNameInput" placeholder="Votre nom">
                        <small>Optionnel</small>
                    </div>
                ` : ''}
                <div class="form-group">
                    <label for="emailInput">Email *</label>
                    <input type="email" id="emailInput" required placeholder="votre@email.com">
                </div>
                <div class="form-group">
                    <label for="passwordInput">Mot de passe *</label>
                    <input type="password" id="passwordInput" required placeholder="••••••••" minlength="6">
                    <small>Minimum 6 caractères</small>
                </div>
                <div class="form-actions">
                    <button type="submit" class="btn-primary">${isLogin ? 'Se connecter' : 'S\'inscrire'}</button>
                    <button type="button" class="btn-secondary" onclick="closeAuthModal()">Annuler</button>
                </div>
                <div class="auth-switch">
                    ${isLogin ? 'Pas encore de compte ? ' : 'Déjà un compte ? '}
                    <a href="#" id="switchAuthMode">${isLogin ? 'S\'inscrire' : 'Se connecter'}</a>
                </div>
            </form>
        `;
    }

    setupAuthFormListeners(mode) {
        const form = document.getElementById('authForm');
        const switchLink = document.getElementById('switchAuthMode');

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.handleAuthSubmit(mode);
        });

        if (switchLink) {
            switchLink.addEventListener('click', (e) => {
                e.preventDefault();
                this.openAuthModal(mode === 'login' ? 'register' : 'login');
            });
        }
    }

    async handleAuthSubmit(mode) {
        const email = document.getElementById('emailInput').value.trim();
        const password = document.getElementById('passwordInput').value.trim();
        const displayName = document.getElementById('displayNameInput')?.value.trim() || '';

        if (!email || !password) {
            this.showNotification('Veuillez remplir tous les champs.');
            return;
        }

        try {
            let result;
            if (mode === 'login') {
                result = await this.authManager.signIn(email, password);
            } else {
                result = await this.authManager.signUp(email, password, displayName);
            }

            if (result.success) {
                this.closeAuthModal();
                if (mode === 'register') {
                    this.showNotification('Inscription réussie ! Vérifiez votre email pour confirmer votre compte.');
                } else {
                    this.showNotification('Connexion réussie !');
                }
            } else {
                this.showNotification(result.error || 'Une erreur est survenue.');
            }
        } catch (error) {
            this.showNotification('Une erreur est survenue. Veuillez réessayer.');
        }
    }

    openModal() {
        if (!this.authManager.isAuthenticated()) {
            this.openAuthModal('login');
            return;
        }

        const modal = document.getElementById('adModal');
        const modalTitle = document.getElementById('modalTitle');
        const modalBody = document.getElementById('modalBody');

        modalTitle.textContent = 'Déposer un article';
        modalBody.innerHTML = this.createAdForm();

        modal.classList.add('active');
        document.body.style.overflow = 'hidden';

        this.currentImages = [];
        this.setupFormListeners();
    }

    createAdForm() {
        return `
            <form id="adForm">
                <div class="form-group">
                    <label for="titleInput">Titre de l'annonce *</label>
                    <input type="text" id="titleInput" required placeholder="Ex: Canapé en bon état">
                    <small>Un titre clair et descriptif</small>
                </div>

                <div class="form-group">
                    <label for="descriptionInput">Description *</label>
                    <textarea id="descriptionInput" required placeholder="Décrivez l'article, son état, dimensions, etc."></textarea>
                    <small>Décrivez votre article en détail</small>
                </div>

                <div class="form-group">
                    <label for="phoneInput">Numéro de téléphone *</label>
                    <input type="tel" id="phoneInput" required placeholder="Ex: 0612345678">
                    <small>Pour que les personnes intéressées puissent vous contacter</small>
                </div>

                <div class="form-group">
                    <label for="categoryInput">Catégorie *</label>
                    <select id="categoryInput" required>
                        <option value="">Choisissez une catégorie</option>
                        <option value="electronique">Électronique</option>
                        <option value="mobilier">Mobilier</option>
                        <option value="vetements">Vêtements</option>
                        <option value="livres">Livres</option>
                        <option value="sport">Sport</option>
                        <option value="cuisine">Cuisine</option>
                        <option value="loisirs">Loisirs</option>
                        <option value="bricolage">Bricolage</option>
                        <option value="jardin">Jardin</option>
                        <option value="autre">Autre</option>
                    </select>
                    <small>Sélectionnez la catégorie qui correspond le mieux à votre article</small>
                </div>

                <div class="form-group">
                    <label>Photos de l'article</label>
                    <div class="file-input-wrapper">
                        <label for="imageInput" class="file-input-label">
                            <span>📸 Cliquez pour ajouter des photos</span>
                        </label>
                        <input type="file" id="imageInput" accept="image/*" multiple>
                    </div>
                    <small>Vous pouvez ajouter plusieurs photos</small>
                    <div id="imagePreviewContainer" class="image-preview-container"></div>
                </div>

                <div class="form-info">
                    <p>ℹ️ Votre annonce sera en attente de validation par un administrateur.</p>
                </div>

                <div class="form-actions">
                    <button type="button" class="btn-secondary" onclick="closeModal()">Annuler</button>
                    <button type="submit" class="btn-primary">Publier l'annonce</button>
                </div>
            </form>
        `;
    }

    setupFormListeners() {
        const form = document.getElementById('adForm');
        const imageInput = document.getElementById('imageInput');

        imageInput.addEventListener('change', async (e) => {
            await this.handleImageUpload(e);
        });
        form.addEventListener('submit', (e) => this.handleFormSubmit(e));
    }

    async handleImageUpload(event) {
        const files = Array.from(event.target.files);

        for (const file of files) {
            if (!file.type.startsWith('image/')) {
                continue;
            }

            try {
                const { compressedFile, previewUrl } = await this.compressImage(file);
                this.currentImageFiles.push(compressedFile);
                this.currentImages.push(previewUrl);
            } catch (error) {
                // Skip file if compression fails
            }
        }

        this.updateImagePreview();
        event.target.value = '';
    }

    compressImage(file) {
        const MAX_WIDTH = 1280;
        const MAX_HEIGHT = 1280;
        const QUALITY = 0.75;

        return new Promise((resolve, reject) => {
            const image = new Image();
            const reader = new FileReader();

            reader.onerror = (error) => reject(error);
            reader.onload = (event) => {
                image.src = event.target.result;
            };

            image.onerror = (error) => reject(error);
            image.onload = () => {
                let { width, height } = image;
                const ratio = Math.min(MAX_WIDTH / width, MAX_HEIGHT / height, 1);

                const canvas = document.createElement('canvas');
                canvas.width = Math.round(width * ratio);
                canvas.height = Math.round(height * ratio);

                const context = canvas.getContext('2d');
                context.drawImage(image, 0, 0, canvas.width, canvas.height);

                canvas.toBlob((blob) => {
                    if (!blob) {
                        reject(new Error('La compression de l\'image a échoué.'));
                        return;
                    }

                    const fileName = this.generateCompressedFileName(file.name);
                    const compressedFile = new File([blob], fileName, { type: 'image/jpeg' });
                    const previewUrl = URL.createObjectURL(blob);

                    resolve({
                        compressedFile,
                        previewUrl,
                        originalSize: file.size,
                        compressedSize: blob.size
                    });
                }, 'image/jpeg', QUALITY);
            };

            reader.readAsDataURL(file);
        });
    }

    generateCompressedFileName(originalName) {
        const baseName = originalName.replace(/\.[^.]+$/, '');
        return `${baseName}_${Date.now()}.jpg`;
    }

    updateImagePreview() {
        const container = document.getElementById('imagePreviewContainer');
        container.innerHTML = this.currentImages.map((image, index) => `
            <div class="image-preview">
                <img src="${image}" alt="Preview ${index + 1}">
                <button type="button" class="image-preview-remove" onclick="uiManager.removeImage(${index})">✕</button>
            </div>
        `).join('');
    }

    removeImage(index) {
        const removedPreview = this.currentImages.splice(index, 1)[0];
        if (removedPreview && removedPreview.startsWith('blob:')) {
            URL.revokeObjectURL(removedPreview);
        }
        this.currentImageFiles.splice(index, 1);
        this.updateImagePreview();
    }

    async handleFormSubmit(event) {
        event.preventDefault();

        if (this.isUploading) return;

        const title = document.getElementById('titleInput').value.trim();
        const description = document.getElementById('descriptionInput').value.trim();
        const phone = document.getElementById('phoneInput').value.trim();
        const category = document.getElementById('categoryInput').value;

        if (!title || !description || !phone || !category) {
            this.showNotification('Veuillez remplir tous les champs obligatoires.');
            return;
        }

        // Validation des longueurs
        if (title.length < 3 || title.length > 100) {
            this.showNotification('Le titre doit contenir entre 3 et 100 caractères.');
            return;
        }

        if (description.length < 10 || description.length > 2000) {
            this.showNotification('La description doit contenir entre 10 et 2000 caractères.');
            return;
        }

        if (phone.length < 8 || phone.length > 20) {
            this.showNotification('Le numéro de téléphone doit contenir entre 8 et 20 caractères.');
            return;
        }

        try {
            this.isUploading = true;
            this.showLoadingState('Publication en cours...');

            // Upload des images vers Storage privé
            let imagePaths = [];
            if (this.currentImageFiles.length > 0) {
                imagePaths = await this.adManager.uploadImages(this.currentImageFiles);
            }

            const ad = {
                title,
                description,
                phone,
                category,
                images_paths: imagePaths
            };

            await this.adManager.addAd(ad);
            await this.adManager.loadAds();

            this.closeModal();
            this.showNotification('Votre annonce a été soumise en attente de validation ! 🎉');
        } catch (error) {
            const errorMsg = error.message || 'Erreur lors de la publication. Veuillez réessayer.';
            this.showNotification(`Erreur: ${errorMsg}`);
        } finally {
            this.isUploading = false;
            this.hideLoadingState();
        }
    }

    async openAdminModal() {
        if (!this.authManager.isAdmin) {
            this.showNotification('Accès refusé.');
            return;
        }

        const modal = document.getElementById('adminModal');
        const modalBody = document.getElementById('adminModalBody');

        modalBody.innerHTML = '<div class="loading">Chargement...</div>';
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';

        // Charger les annonces en attente
        const pendingAds = await this.adManager.loadPendingAds();
        modalBody.innerHTML = this.createAdminView(pendingAds);
        this.setupAdminListeners();
    }

    createAdminView(pendingAds) {
        if (pendingAds.length === 0) {
            return '<div class="empty-admin">Aucune annonce en attente de validation.</div>';
        }

        return `
            <div class="admin-pending-list">
                ${pendingAds.map(ad => `
                    <div class="admin-pending-item" data-id="${ad.id}">
                        <div class="admin-item-header">
                            <h3>${this.escapeHtml(ad.title)}</h3>
                            <span class="admin-item-author">Par: ${ad.profiles?.display_name || 'Inconnu'}</span>
                        </div>
                        <div class="admin-item-content">
                            <p>${this.escapeHtml(ad.description)}</p>
                            <div class="admin-item-images">
                                ${ad.images && ad.images.length > 0 ? ad.images.map(img => 
                                    `<img src="${img}" alt="Preview" class="admin-item-thumb" onerror="this.style.display='none'">`
                                ).join('') : '<span style="color: #666; font-style: italic;">Aucune image ou image non disponible</span>'}
                            </div>
                            <div class="admin-item-meta">
                                <span>
                                    <svg class="admin-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"></path>
                                    </svg>
                                    ${this.formatPhone(ad.phone)}
                                </span>
                                <span>
                                    <svg class="admin-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                                        <line x1="16" y1="2" x2="16" y2="6"></line>
                                        <line x1="8" y1="2" x2="8" y2="6"></line>
                                        <line x1="3" y1="10" x2="21" y2="10"></line>
                                    </svg>
                                    ${this.formatDate(ad.createdAt)}
                                </span>
                            </div>
                        </div>
                        <div class="admin-item-actions">
                            <button class="btn-primary btn-approve" data-id="${ad.id}">✓ Approuver</button>
                            <button class="btn-danger btn-reject" data-id="${ad.id}">✕ Rejeter</button>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    setupAdminListeners() {
        const approveBtns = document.querySelectorAll('.btn-approve');
        const rejectBtns = document.querySelectorAll('.btn-reject');

        approveBtns.forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const adId = e.target.dataset.id;
                await this.handleApproveAd(adId);
            });
        });

        rejectBtns.forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const adId = e.target.dataset.id;
                await this.handleRejectAd(adId);
            });
        });
    }

    async handleApproveAd(adId) {
        if (!confirm('Approuver cette annonce ?')) return;

        try {
            await this.adManager.updateAdStatus(adId, 'approved', this.authManager.getUserId());
            await this.adManager.loadAds();
            this.openAdminModal(); // Recharger la liste
            this.showNotification('Annonce approuvée !');
        } catch (error) {
            this.showNotification('Erreur lors de l\'approbation.');
        }
    }

    async handleRejectAd(adId) {
        if (!confirm('Rejeter cette annonce ?')) return;

        try {
            await this.adManager.updateAdStatus(adId, 'rejected', this.authManager.getUserId());
            this.openAdminModal(); // Recharger la liste
            this.showNotification('Annonce rejetée.');
        } catch (error) {
            this.showNotification('Erreur lors du rejet.');
        }
    }

    async showAdDetail(adId) {
        const ad = this.adManager.getAd(adId);
        if (!ad) return;

        const modal = document.getElementById('detailModal');
        const modalBody = document.getElementById('detailModalBody');

        modalBody.innerHTML = this.createDetailView(ad);
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';

        this.setupImageGallery(ad.images);
        this.setupDetailButtons(adId, ad);
        this.setupStatusControls(adId, ad);
    }

    createDetailView(ad) {
        const hasImages = ad.images && ad.images.length > 0;
        const mainImage = hasImages ? ad.images[0] : '';
        const date = this.formatDate(ad.createdAt);
        const isOwner = this.authManager.isAuthenticated() && 
                       ad.user_id === this.authManager.getUserId();
        const isAdmin = this.authManager.isAdmin;

        return `
            <div class="detail-header">
                <h2 class="detail-title">${this.escapeHtml(ad.title)}</h2>
                <div class="detail-meta">
                    <span class="detail-date">
                        <svg class="detail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                            <line x1="16" y1="2" x2="16" y2="6"></line>
                            <line x1="8" y1="2" x2="8" y2="6"></line>
                            <line x1="3" y1="10" x2="21" y2="10"></line>
                        </svg>
                        Publié le ${date}
                    </span>
                    ${this.createStatusBadge(ad.item_status || 'available')}
                </div>
            </div>

            ${hasImages ? `
                <div class="detail-images">
                    <img src="${mainImage}" alt="${ad.title}" class="detail-image-main" id="mainImage">
                    ${ad.images.length > 1 ? `
                        <div class="detail-image-thumbnails">
                            ${ad.images.map((img, index) => `
                                <img src="${img}" 
                                     alt="Image ${index + 1}" 
                                     class="detail-image-thumb ${index === 0 ? 'active' : ''}" 
                                     data-index="${index}">
                            `).join('')}
                        </div>
                    ` : ''}
                </div>
            ` : ''}

            <div class="detail-description">
                <h3>Description</h3>
                <p>${this.escapeHtml(ad.description)}</p>
            </div>

            <div class="detail-contact">
                <h3>Contact</h3>
                <div class="contact-phone">
                    <svg class="contact-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"></path>
                    </svg>
                    ${this.formatPhone(ad.phone)}
                </div>
                ${this.authManager.isAuthenticated() && ad.user_id !== this.authManager.getUserId() ? `
                    <button class="btn-primary btn-contact" data-ad-id="${ad.id}" data-seller-id="${ad.user_id}">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"></path>
                        </svg>
                        Envoyer un message
                    </button>
                ` : ''}
                <p class="contact-info">Contactez le donateur par téléphone ou message pour récupérer cet article</p>
            </div>

            ${isOwner ? `
                <div class="detail-status-control">
                    <h3>Statut de l'article</h3>
                    <p class="status-help">Mettez à jour le statut pour informer les autres utilisateurs</p>
                    <div class="status-buttons">
                        <button class="status-control-btn ${(ad.item_status || 'available') === 'available' ? 'active' : ''}" 
                                data-status="available" data-ad-id="${ad.id}">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M9 12l2 2 4-4"></path>
                                <circle cx="12" cy="12" r="10"></circle>
                            </svg>
                            Disponible
                        </button>
                        <button class="status-control-btn ${(ad.item_status || 'available') === 'reserved' ? 'active' : ''}" 
                                data-status="reserved" data-ad-id="${ad.id}">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="10"></circle>
                                <path d="M12 6v6l4 2"></path>
                            </svg>
                            Réservé
                        </button>
                        <button class="status-control-btn ${(ad.item_status || 'available') === 'given_away' ? 'active' : ''}" 
                                data-status="given_away" data-ad-id="${ad.id}">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M20 6L9 17l-5-5"></path>
                            </svg>
                            Donné
                        </button>
                    </div>
                </div>
            ` : ''}

            ${(isOwner || isAdmin) ? `
                <div class="detail-actions">
                    <button class="btn-danger" id="deleteAdBtn">Supprimer l'annonce</button>
                    <button class="btn-secondary" onclick="closeDetailModal()">Fermer</button>
                </div>
            ` : `
                <div class="detail-actions">
                    <button class="btn-secondary" onclick="closeDetailModal()">Fermer</button>
                </div>
            `}
        `;
    }

    setupImageGallery(images) {
        if (!images || images.length <= 1) return;

        const mainImage = document.getElementById('mainImage');
        const thumbnails = document.querySelectorAll('.detail-image-thumb');

        thumbnails.forEach(thumb => {
            thumb.addEventListener('click', (e) => {
                const index = parseInt(e.target.dataset.index);
                mainImage.src = images[index];
                
                thumbnails.forEach(t => t.classList.remove('active'));
                e.target.classList.add('active');
            });
        });
    }

    setupDetailButtons(adId, ad) {
        // Setup delete button
        const deleteBtn = document.getElementById('deleteAdBtn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => this.handleDeleteAd(adId, ad));
        }

        // Setup contact button
        const contactBtn = document.querySelector('.btn-contact');
        if (contactBtn) {
            contactBtn.addEventListener('click', (e) => {
                const adId = e.currentTarget.dataset.adId;
                const sellerId = e.currentTarget.dataset.sellerId;
                this.startConversation(adId, sellerId);
            });
        }
    }

    setupStatusControls(adId, ad) {
        const statusButtons = document.querySelectorAll('.status-control-btn');
        
        statusButtons.forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                const newStatus = e.currentTarget.dataset.status;
                const currentAdId = e.currentTarget.dataset.adId;
                
                // Convert both to strings for comparison
                if (String(currentAdId) === String(adId)) {
                    await this.handleStatusUpdate(adId, newStatus);
                }
            });
        });
    }

    async handleStatusUpdate(adId, newStatus) {
        try {
            await this.adManager.updateItemStatus(adId, newStatus);
            
            // Update UI immediately
            document.querySelectorAll('.status-control-btn').forEach(btn => {
                btn.classList.remove('active');
            });
            document.querySelector(`[data-status="${newStatus}"]`).classList.add('active');
            
            // Update status badge in detail view
            const statusBadge = document.querySelector('.detail-meta .status-badge');
            if (statusBadge) {
                const newBadge = this.createStatusBadge(newStatus);
                statusBadge.outerHTML = newBadge;
            }
            
            // Reload ads to update the main view
            await this.adManager.loadAds();
            this.renderAds();
            
            this.showNotification('Statut mis à jour avec succès !');
        } catch (error) {
            this.showNotification('Erreur lors de la mise à jour. Veuillez réessayer.');
        }
    }

    async handleDeleteAd(adId, ad) {
        const isOwner = this.authManager.isAuthenticated() && 
                       ad.user_id === this.authManager.getUserId();
        const isAdmin = this.authManager.isAdmin;

        if (!isOwner && !isAdmin) {
            this.showNotification('Vous n\'avez pas la permission de supprimer cette annonce.');
            return;
        }

        if (!confirm('Êtes-vous sûr de vouloir supprimer cette annonce ?')) {
            return;
        }

        try {
            await this.adManager.deleteAd(adId);
            await this.adManager.loadAds();
            this.closeDetailModal();
            this.showNotification('L\'annonce a été supprimée.');
        } catch (error) {
            this.showNotification('Erreur lors de la suppression. Veuillez réessayer.');
        }
    }

    closeModal() {
        const modal = document.getElementById('adModal');
        modal.classList.remove('active');
        document.body.style.overflow = '';
        this.currentImages.forEach(preview => {
            if (preview && preview.startsWith('blob:')) {
                URL.revokeObjectURL(preview);
            }
        });
        this.currentImages = [];
        this.currentImageFiles = [];
    }

    closeAuthModal() {
        const modal = document.getElementById('authModal');
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }

    closeAdminModal() {
        const modal = document.getElementById('adminModal');
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }

    showLoadingState(message) {
        const modal = document.getElementById('adModal');
        const overlay = document.createElement('div');
        overlay.id = 'loadingOverlay';
        overlay.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 9999;
            flex-direction: column;
            gap: 20px;
        `;
        overlay.innerHTML = `
            <div style="color: white; font-size: 1.2rem;">${message}</div>
            <div class="loader"></div>
        `;
        modal.querySelector('.modal-content').appendChild(overlay);
    }

    hideLoadingState() {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) {
            overlay.remove();
        }
    }

    closeDetailModal() {
        const modal = document.getElementById('detailModal');
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }

    showNotification(message) {
        // Create a toast notification instead of alert
        const toast = document.createElement('div');
        toast.className = 'toast-notification';
        toast.textContent = message;
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: var(--primary-color);
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            box-shadow: var(--shadow-lg);
            z-index: 10000;
            font-family: 'Inter', sans-serif;
            font-size: 0.9rem;
            max-width: 300px;
            word-wrap: break-word;
            animation: slideInRight 0.3s ease;
        `;
        
        document.body.appendChild(toast);
        
        // Remove after 4 seconds
        setTimeout(() => {
            toast.style.animation = 'slideOutRight 0.3s ease';
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 300);
        }, 4000);
    }

    formatDate(isoDate) {
        const date = new Date(isoDate);
        const now = new Date();
        const diffTime = Math.abs(now - date);
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

        if (diffDays === 0) {
            const diffHours = Math.floor(diffTime / (1000 * 60 * 60));
            if (diffHours === 0) {
                const diffMinutes = Math.floor(diffTime / (1000 * 60));
                return diffMinutes <= 1 ? 'À l\'instant' : `Il y a ${diffMinutes} min`;
            }
            return diffHours === 1 ? 'Il y a 1 heure' : `Il y a ${diffHours} heures`;
        } else if (diffDays === 1) {
            return 'Hier';
        } else if (diffDays < 7) {
            return `Il y a ${diffDays} jours`;
        } else {
            return date.toLocaleDateString('fr-FR', { 
                day: 'numeric', 
                month: 'long', 
                year: 'numeric' 
            });
        }
    }

    formatPhone(phone) {
        const cleaned = phone.replace(/\D/g, '');
        if (cleaned.length === 10) {
            return cleaned.replace(/(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1 $2 $3 $4 $5');
        }
        return phone;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ==================== Messaging UI Methods ====================

    async openMessagesModal() {
        if (!this.authManager.isAuthenticated()) {
            this.openAuthModal('login');
            return;
        }

        const modal = document.getElementById('messagesModal');
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';

        await this.loadConversationsUI();
        
        // Update badge when modal opens
        this.updateUnreadBadge();
    }

    async loadConversationsUI() {
        const conversationsList = document.getElementById('conversationsList');
        
        if (!this.messageManager) {
            conversationsList.innerHTML = '<div class="loading">Chargement...</div>';
            return;
        }

        await this.messageManager.loadConversations();
        const conversations = this.messageManager.conversations;

        if (conversations.length === 0) {
            conversationsList.innerHTML = `
                <div class="empty-conversations">
                    <p>Aucune conversation pour le moment</p>
                    <small>Contactez un vendeur pour commencer une discussion</small>
                </div>
            `;
            return;
        }

        conversationsList.innerHTML = conversations.map(conv => {
            const otherUser = conv.buyer_id === this.authManager.getUserId() 
                ? conv.seller 
                : conv.buyer;
            const lastMessage = conv.lastMessage;
            const timeAgo = lastMessage ? this.formatDate(lastMessage.created_at) : '';
            
            return `
                <div class="conversation-item ${conv.unreadCount > 0 ? 'unread' : ''}" 
                     data-conversation-id="${conv.id}">
                    <div class="conversation-header">
                        <h4>${this.escapeHtml(conv.ad?.title || 'Article supprimé')}</h4>
                        <span class="conversation-time">${timeAgo}</span>
                    </div>
                    <div class="conversation-meta">
                        <span class="other-user">avec ${this.escapeHtml(otherUser?.display_name || 'Utilisateur')}</span>
                        ${conv.unreadCount > 0 ? `<span class="unread-count">${conv.unreadCount}</span>` : ''}
                    </div>
                    <div class="last-message">
                        ${lastMessage ? this.escapeHtml(lastMessage.content) : 'Aucun message'}
                    </div>
                </div>
            `;
        }).join('');

        // Add click listeners
        conversationsList.querySelectorAll('.conversation-item').forEach(item => {
            item.addEventListener('click', async () => {
                const conversationId = item.dataset.conversationId;
                await this.openChat(conversationId);
            });
        });
    }

    async openChat(conversationId) {
        const chatArea = document.getElementById('chatArea');
        const conversation = this.messageManager.getConversation(conversationId);
        
        if (!conversation) return;

        // Track currently open conversation
        this.currentOpenConversation = conversationId;

        // Mark messages as read
        await this.messageManager.markMessagesAsRead(conversationId);
        
        // Update unread badge immediately
        this.updateUnreadBadge();

        // Load messages
        const messages = await this.messageManager.loadMessages(conversationId);
        
        const otherUser = conversation.buyer_id === this.authManager.getUserId() 
            ? conversation.seller 
            : conversation.buyer;

        chatArea.innerHTML = `
            <button class="chat-back-btn" id="chatBackBtn">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M19 12H5M12 19l-7-7 7-7"></path>
                </svg>
                Retour
            </button>
            <div class="chat-header">
                <h3>${this.escapeHtml(conversation.ad?.title || 'Article supprimé')}</h3>
                <span class="chat-with">Discussion avec ${this.escapeHtml(otherUser?.display_name || 'Utilisateur')}</span>
            </div>
            <div class="chat-messages" id="chatMessages">
                ${messages.map(msg => this.createMessageBubble(msg)).join('')}
            </div>
            <div class="chat-input-area">
                <div class="chat-input-wrapper">
                    <input type="text" id="messageInput" placeholder="Tapez votre message..." maxlength="1000">
                    <button id="sendMessageBtn" class="btn-send">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="22" y1="2" x2="11" y2="13"></line>
                            <polygon points="22,2 15,22 11,13 2,9"></polygon>
                        </svg>
                    </button>
                </div>
            </div>
        `;

        // Add mobile chat view class
        const messagesContainer = document.querySelector('.messages-container');
        if (messagesContainer) {
            messagesContainer.classList.add('chat-open');
        }

        // Setup back button for mobile
        const backBtn = document.getElementById('chatBackBtn');
        if (backBtn) {
            backBtn.addEventListener('click', () => {
                messagesContainer.classList.remove('chat-open');
                this.currentOpenConversation = null;
            });
        }

        // Setup chat input listeners
        this.setupChatListeners(conversationId);
        
        // Scroll to bottom
        const chatMessages = document.getElementById('chatMessages');
        chatMessages.scrollTop = chatMessages.scrollHeight;

        // Update conversations list UI
        await this.loadConversationsUI();
    }

    createMessageBubble(message) {
        const isOwn = message.sender_id === this.authManager.getUserId();
        const time = new Date(message.created_at).toLocaleTimeString('fr-FR', { 
            hour: '2-digit', 
            minute: '2-digit' 
        });

        return `
            <div class="message ${isOwn ? 'own' : 'other'}">
                <div class="message-content">${this.escapeHtml(message.content)}</div>
                <div class="message-time">${time}</div>
            </div>
        `;
    }

    setupChatListeners(conversationId) {
        const messageInput = document.getElementById('messageInput');
        const sendBtn = document.getElementById('sendMessageBtn');

        const sendMessage = async () => {
            const content = messageInput.value.trim();
            if (!content) return;

            try {
                await this.messageManager.sendMessage(conversationId, content);
                messageInput.value = '';
                
                // Refresh chat
                await this.openChat(conversationId);
            } catch (error) {
                this.showNotification('Erreur lors de l\'envoi du message');
            }
        };

        sendBtn.addEventListener('click', sendMessage);
        messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                sendMessage();
            }
        });
    }

    async startConversation(adId, sellerId) {
        try {
            const conversation = await this.messageManager.createConversation(adId, sellerId);
            if (conversation) {
                this.openMessagesModal();
                setTimeout(() => this.openChat(conversation.id), 500);
            }
        } catch (error) {
            this.showNotification('Erreur lors de la création de la conversation');
        }
    }

    updateUnreadBadge() {
        const badge = document.getElementById('unreadBadge');
        if (badge && this.messageManager) {
            const count = this.messageManager.unreadCount;
            if (count > 0) {
                badge.textContent = count > 99 ? '99+' : count.toString();
                badge.style.display = 'inline';
            } else {
                badge.style.display = 'none';
            }
        }
    }

    handleNewMessage(message) {
        // Update unread badge
        this.updateUnreadBadge();
        
        // If messages modal is open
        const modal = document.getElementById('messagesModal');
        if (modal.classList.contains('active')) {
            // Refresh conversations list
            this.loadConversationsUI();
            
            // If the chat is currently open for this conversation, refresh it
            const chatArea = document.getElementById('chatArea');
            const activeConversation = this.currentOpenConversation;
            
            if (activeConversation && chatArea && !chatArea.querySelector('.chat-placeholder')) {
                // Check if this message belongs to the currently open conversation
                const conversation = this.messageManager.conversations.find(c => 
                    c.id === message.conversation_id
                );
                
                if (conversation && activeConversation === message.conversation_id) {
                    // Refresh the chat to show the new message
                    this.openChat(message.conversation_id);
                }
            }
        }
        
        // Show notification if message is not from current user
        if (message.sender_id !== this.authManager.getUserId()) {
            this.showNotification('Nouveau message reçu');
        }
    }

    closeMessagesModal() {
        const modal = document.getElementById('messagesModal');
        modal.classList.remove('active');
        document.body.style.overflow = '';
        this.currentOpenConversation = null;
        
        // Reset mobile chat view
        const messagesContainer = document.querySelector('.messages-container');
        if (messagesContainer) {
            messagesContainer.classList.remove('chat-open');
        }
    }
}

// ==================== Theme Management ====================

class ThemeManager {
    constructor() {
        this.theme = this.loadTheme();
        this.init();
    }

    init() {
        this.applyTheme(this.theme);
        this.setupEventListeners();
    }

    loadTheme() {
        const savedTheme = localStorage.getItem('cityBankTheme');
        if (savedTheme) {
            return savedTheme;
        }
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            return 'dark';
        }
        return 'light';
    }

    applyTheme(theme) {
        this.theme = theme;
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('cityBankTheme', theme);
    }

    toggleTheme() {
        const newTheme = this.theme === 'light' ? 'dark' : 'light';
        this.applyTheme(newTheme);
    }

    setupEventListeners() {
        const toggleBtn = document.getElementById('themeToggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => this.toggleTheme());
        }
    }
}

// ==================== Initialization ====================

let authManager;
let adManager;
let messageManager;
let uiManager;
let themeManager;

document.addEventListener('DOMContentLoaded', async () => {
    themeManager = new ThemeManager();
    authManager = new AuthManager();
    await authManager.init();
    
    adManager = new AdManager(authManager);
    messageManager = new MessageManager(authManager);
    uiManager = new UIManager(adManager, authManager, messageManager);
    
    // Initialize messaging if user is authenticated
    if (authManager.isAuthenticated()) {
        await messageManager.init();
    }
    
    window.uiManager = uiManager;
    window.authManager = authManager;
    window.messageManager = messageManager;
});

// Global functions for onclick handlers
window.openModal = function() {
    if (window.uiManager) {
        window.uiManager.openModal();
    }
}

window.closeModal = function() {
    if (window.uiManager) {
        window.uiManager.closeModal();
    }
}

window.closeDetailModal = function() {
    if (window.uiManager) {
        window.uiManager.closeDetailModal();
    }
}

window.closeAuthModal = function() {
    if (window.uiManager) {
        window.uiManager.closeAuthModal();
    }
}

window.closeAdminModal = function() {
    if (window.uiManager) {
        window.uiManager.closeAdminModal();
    }
}

window.closeMessagesModal = function() {
    if (window.uiManager) {
        window.uiManager.closeMessagesModal();
    }
}
