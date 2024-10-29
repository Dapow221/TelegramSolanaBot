require("dotenv").config();
const { Connection, PublicKey } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const axios = require("axios")
const express = require("express")
const token = process.env.TOKEN_TELEGRAM
const rpc_solana_url = process.env.RPC_URL
const connection = new Connection(rpc_solana_url);
const bot = new TelegramBot(token);

const app = express()
const port = 3000

app.post(`/webhook/${token}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

if (process.env.NODE_ENV === 'production') {
    const webhookUrl = `https://telegram-solana-bot.vercel.app/webhook/${token}`;
    bot.setWebHook(webhookUrl);
}

app.get('/', (req, res) => {
  res.send('Hello World!')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})

let wallets = [];
let subscriptions = [];

const getFromDexScreener = async (mint) => {
    try {
        const data = await axios.get(
            `https://api.dexscreener.com/latest/dex/tokens/${mint}`
        );

        if (data.data) {
            if (!data.data?.pairs) return null;

            if (data.data?.pairs?.length === 0) {
                return null;
            }

            const {
                marketCap = null,
                baseToken = null,
                priceUsd = null
            } = data.data?.pairs?.[0];

            if (!marketCap || !baseToken || !priceUsd) return null;

            const { name, symbol } = baseToken;

            return {
                name,
                symbol,
                marketCap,
                priceUsd
            };
        }

        return null;
    } catch (e) {
        console.log(e);

        return null;
    }
};

const getFromPumpFun = async (mint) => {
    try {
        const data = await axios.get(
            `https://frontend-api.pump.fun/coins/${mint}`
        );

        if (data.data) {
            const { name, symbol, usd_market_cap } = data.data;

            return {
                name,
                symbol,
                marketCap: usd_market_cap,
                priceUsd: 'N/A'
            };
        }

        return null;
    } catch (e) {
        console.log(e);

        return null;
    }
};

const getTokenMeta = async (mint) => {
    console.log('Ticker Info from dexscreener api');

    let tokenMeta = await getFromDexScreener(mint);

    if (tokenMeta) {
        return tokenMeta;
    }

    console.log('Ticker Info from pumpfun api');

    tokenMeta = await getFromPumpFun(mint);

    if (tokenMeta) {
        return tokenMeta;
    }

    console.log('Failed to get ticker info');

    return {
        name: 'N/A',
        symbol: 'N/A',
        marketCap: 'N/A',
        priceUsd: 'N/A'
    };
};

const stopTrackWalletTransactions = (address) => {
    try {
        const subscriptionIndex = subscriptions.findIndex(sub => sub.address === address);
        if (subscriptionIndex === -1) {
            console.log(`No subscription found for address: ${address}`);
            return false;
        }

        connection.removeOnLogsListener(subscriptions[subscriptionIndex].subscriptionId);
        
        subscriptions.splice(subscriptionIndex, 1);
        
        const walletIndex = wallets.findIndex(wallet => wallet.address === address);
        if (walletIndex !== -1) {
            wallets.splice(walletIndex, 1);
        }

        console.log(`Successfully stopped tracking wallet: ${address}`);
        return true;
    } catch (error) {
        console.error('Error stopping wallet tracking:', error);
        return false;
    }
};

const trackWalletTransactions = (address) => {
    try {
        const publicKey = new PublicKey(address);

        const subscriptionId = connection.onLogs(publicKey, async (logInfo) => {
            console.log('New transaction detected for wallet:', address);

            const signature = logInfo.signature;
            const transaction = await connection.getTransaction(signature, {
                maxSupportedTransactionVersion: 0
            });

            if (transaction) {
                const preBalances = transaction.meta?.preBalances || [];
                const postBalances = transaction.meta?.postBalances || [];
                const preTokenBalances = transaction.meta?.preTokenBalances || [];
                const postTokenBalances = transaction.meta?.postTokenBalances || [];

                const solSpent = (preBalances[0] - postBalances[0]) / 1e9;
                const solReceived = (postBalances[0] - preBalances[0]) / 1e9;

                let tokenMint = '';
                let tokenAmount = 0;
                let tokenSold = 0;
                let tokenBought = 0;
                let typeTransactions = '';

                const walletInfo = wallets.find(w => w.address === address);
                if (!walletInfo) {
                    console.log('Wallet not found in array.');
                    return;
                }

                postTokenBalances.forEach((postTokenBalance, index) => {
                    const preTokenBalance = preTokenBalances[index] || {};
                    tokenMint = postTokenBalance.mint;
                    tokenAmount = postTokenBalance.uiTokenAmount.uiAmount;
                    const preTokenAmount = preTokenBalance.uiTokenAmount?.uiAmount || 0;

                    if (preTokenAmount > tokenAmount && solReceived > 0) {
                        tokenSold = preTokenAmount - tokenAmount;
                        if (tokenSold > 0.001) {
                            typeTransactions = 'sell';
                        }
                    } else if (tokenAmount > preTokenAmount && solSpent > 0) {
                        tokenBought = tokenAmount - preTokenAmount;
                        if (tokenBought > 0.001) {
                            typeTransactions = 'buy';
                        }
                    }
                });

                if (typeTransactions) {
                    const tokenMeta = await getTokenMeta(tokenMint);
                    
                    const message = `
${typeTransactions === 'sell' ? '🔴 SELL' : '🟢 BUY'} - ${walletInfo.label}

🪙 Token Info:
✨ $${tokenMeta.symbol} (${tokenMeta.name})
💰 MCAP: $${tokenMeta.marketCap}
💵 Price: $${tokenMeta.priceUsd}
💡 CA: ${tokenMint}

📊 Transaction Info:
${typeTransactions === 'buy' ? `💸 SOL: -${solSpent}` : `💸 SOL: +${solReceived}`}
💰 ${tokenMeta.symbol}: ${typeTransactions === 'buy' ? `+${tokenBought}` : `-${tokenSold}`}
✊ Current Hold: ${tokenAmount ?? 0}

🔗 Links:
• [Solscan](https://solscan.io/tx/${signature})
• [DexScreener](https://dexscreener.com/solana/${tokenMint})
• [PumpFun](https://pump.fun/${tokenMint})

Buy on:
• [GMGN](https://t.me/GMGN_sol02_bot?start=i_ihAxNciQ)
• [Trojan](https://t.me/achilles_trojanbot?start=r-typeewrite-${tokenMint})`;

                    bot.sendMessage(walletInfo.chatId, message, {
                        parse_mode: 'HTML',
                        disable_web_page_preview: true
                    });
                } else {
                    console.log('Transaction not relevant or significant.');
                }
            } else {
                console.log('Transaction not found or not confirmed.');
            }
        });

        subscriptions.push({
            address,
            subscriptionId
        });

        console.log(`${address} tracked`);
    } catch (error) {
        console.error('Error tracking transactions:', error);
    }
};

bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const messageText = msg.text;

    if (!messageText) return;

    const [command, ...args] = messageText.split(' ');

    switch (command.toLowerCase()) {
        case '/start':
            bot.sendMessage(chatId, 
                'Welcome to Solana Wallet Tracker Bot!\n\n' +
                'Available commands:\n' +
                '/add <wallet_address> <label> - Add a wallet to track\n' +
                '/remove <wallet_address> - Stop tracking a wallet\n' +
                '/list - Show all tracked wallets\n' +
                '/delete <wallet_address> - Delete a wallet from tracking\n' +
                '/help - Show this help message'
            );
            break;

        case '/add':
            if (args.length < 2) {
                bot.sendMessage(chatId, 'Usage: /add <wallet_address> <label>');
                return;
            }
            const [address, ...labelParts] = args;
            const label = labelParts.join(' ');
            
            const added = add(chatId, address, label);
            bot.sendMessage(chatId, 
                added ? 
                `Successfully added wallet ${address} with label "${label}"` :
                'Wallet already being tracked or invalid address'
            );
            break;

        case '/remove':
            if (args.length < 1) {
                bot.sendMessage(chatId, 'Usage: /remove <wallet_address>');
                return;
            }
            const removed = stopTrackWalletTransactions(args[0]);
            bot.sendMessage(chatId,
                removed ?
                `Successfully stopped tracking wallet ${args[0]}` :
                'Wallet not found or not being tracked'
            );
            break;

        case '/delete':
            if (args.length < 1) {
                bot.sendMessage(chatId, 'Usage: /delete <wallet_address>');
                return;
            }
            const deleted = deleteWallet(args[0], chatId);
            bot.sendMessage(chatId,
                deleted ?
                `Successfully deleted wallet ${args[0]}` :
                'Wallet not found or not authorized to delete'
            );
            break;

        case '/list':
            const walletList = list(chatId);
            bot.sendMessage(chatId, walletList);
            break;

        case '/help':
            bot.sendMessage(chatId,
                'Available commands:\n' +
                '/add <wallet_address> <label> - Add a wallet to track\n' +
                '/remove <wallet_address> - Stop tracking a wallet\n' +
                '/list - Show all tracked wallets\n' +
                '/delete <wallet_address> - Delete a wallet from tracking\n' +
                '/help - Show this help message'
            );
            break;

        default:
            bot.sendMessage(chatId, 'Unknown command. Use /help to see available commands.');
    }
});

const add = (chatId, address, label) => {

    if (wallets.some(w => w.address === address)) {
        console.log(`Wallet ${address} already tracked`);
        return false;
    }

    try {
        new PublicKey(address);

        wallets.push({
            address,
            label,
            chatId
        });

        trackWalletTransactions(address);
        
        console.log(`Wallet ${address} added with label "${label}" for chat ${chatId}`);
        return true;
    } catch (error) {
        console.error('Error adding wallet:', error);
        return false;
    }
};

const deleteWallet = (address, chatId) => {
    const walletIndex = wallets.findIndex(w => w.address === address && w.chatId === chatId);
    
    if (walletIndex === -1) {
        return false;
    }

    stopTrackWalletTransactions(address);
    
    wallets.splice(walletIndex, 1);
    
    return true;
};

const list = (chatId) => {
    const chatWallets = wallets.filter(w => w.chatId === chatId);

    if (chatWallets.length === 0) {
        return 'No wallets tracked yet';
    }

    return chatWallets.map((wallet, index) => {
        return `${index + 1}. ${wallet.address} (${wallet.label})`;
    }).join('\n');
};

wallets.forEach(wallet => {
    trackWalletTransactions(wallet.address);
});

module.exports = app;


