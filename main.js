const { app, BrowserWindow, ipcMain, Tray, Menu } = require('electron');
const { autoUpdater } = require("electron-updater");
const path = require('path');
const io = require('socket.io-client');

let mainWindow;
let socket;
let mapeamentoImpressoras = {}; // { idSetor: "Nome", "caixa": "Nome", "viasCaixa": 1 }
const cacheUltimosPedidos = new Map(); // Cache temporário para re-impressão manual

let tokenLocal = '';
let restauranteIdLocal = '';
let tray = null;
let appIsQuitting = false;

// O Electron cuidará automaticamente da pasta de dados baseada no nome do app em package.json
// Isso evita o erro de "Acesso Negado" ao tentar forçar caminhos manuais.

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
    });

    mainWindow.loadFile('index.html');

    mainWindow.on('close', (event) => {
        if (!appIsQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
        return false;
    });

    // mainWindow.webContents.openDevTools();

    mainWindow.on('closed', function () {
        mainWindow = null;
    });
}

function createTray() {
    // Usando o favicon copiado para os assets locais
    const iconPath = path.join(__dirname, 'assets', 'favicon.png');

    tray = new Tray(iconPath);

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Abrir Painel',
            click: () => {
                mainWindow.show();
            }
        },
        { type: 'separator' },
        {
            label: 'Sair do Programa',
            click: () => {
                appIsQuitting = true;
                app.quit();
            }
        }
    ]);

    tray.setToolTip('DashEats');
    tray.setContextMenu(contextMenu);

    tray.on('double-click', () => {
        mainWindow.show();
    });
}

app.on('ready', () => {
    createWindow();
    createTray();

    // Configurar inicialização com o Windows (Auto-launch)
    if (app.isPackaged) {
        app.setLoginItemSettings({
            openAtLogin: true,
            path: process.execPath,
            args: ['--hidden']
        });
    }

    // Se o app foi iniciado pelo Windows (com o argumento --hidden), mantê-lo oculto no tray
    if (process.argv.includes('--hidden')) {
        if (mainWindow) {
            mainWindow.hide();
        }
    }

    // Iniciar verificação de atualizações silenciosamente
    autoUpdater.checkForUpdatesAndNotify();
});

autoUpdater.on('update-available', () => {
    console.log('Atualização encontrada! Baixando...');
    if (mainWindow) {
        mainWindow.webContents.send('nova-impressao', {
            id: Date.now() + 1,
            mensagem: `⬇️ Atualização encontrada. Baixando em segundo plano...`,
            status: 'pendente'
        });
    }
});

autoUpdater.on('update-downloaded', () => {
    console.log('Atualização baixada. O app será atualizado ao ser reiniciado.');
    if (mainWindow) {
        mainWindow.webContents.send('nova-impressao', {
            id: Date.now() + 2,
            mensagem: `✅ Nova versão pronta! Feche o aplicativo e abra novamente para atualizar.`,
            status: 'sucesso'
        });
    }
});


app.on('window-all-closed', function () {
    if (process.platform !== 'darwin' && appIsQuitting) app.quit();
});

app.on('activate', function () {
    if (mainWindow === null) createWindow();
    else mainWindow.show();
});

// IPC: Carregar Impressoras do Sistema
ipcMain.handle('obter-impressoras', async () => {
    return await mainWindow.webContents.getPrintersAsync();
});

// IPC: Realizar Login via Backend
ipcMain.handle('fazer-login-api', async (event, { email, senha }) => {
    try {
        const response = await fetch("https://api.dasheats.com.br/authenticate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, senha })
        });
        const data = await response.json();

        if (response.ok && data.usuario) {
            return {
                sucesso: true,
                token: data.token,
                refreshToken: data.refreshToken,
                restauranteId: data.usuario.restauranteId
            };
        } else {
            return { sucesso: false, erro: data.error || "Erro ao fazer login" };
        }
    } catch (err) {
        console.error("Erro no login main process:", err);
        return { sucesso: false, erro: "Servidor Indisponível" };
    }
});

// IPC: Renovar Token
ipcMain.handle('renovar-login-api', async (event, refreshToken) => {
    try {
        const response = await fetch("https://api.dasheats.com.br/refresh-token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refreshToken })
        });
        const data = await response.json();

        if (response.ok) {
            return {
                sucesso: true,
                token: data.token,
                refreshToken: data.refreshToken
            };
        } else {
            return { sucesso: false, erro: "Sessão Expirada" };
        }
    } catch (err) {
        return { sucesso: false, erro: "Sem conexão" };
    }
});

// IPC: Salvar Mapeamento
ipcMain.on('salvar-mapeamento', (event, mapeamento) => {
    mapeamentoImpressoras = mapeamento;
    console.log("Mapeamento de impressoras atualizado:", mapeamentoImpressoras);
});

// IPC: Iniciar Conexão com o Servidor
ipcMain.on('iniciar-conexao', (event, credenciais) => {
    const { token, restauranteId } = credenciais;
    tokenLocal = token;
    restauranteIdLocal = restauranteId;

    if (socket) socket.disconnect();

    socket = io("https://api.dasheats.com.br", {
        auth: { token: token },
        transports: ['polling', 'websocket'], // Adicionado polling como fallback para maior compatibilidade
        reconnectionAttempts: 10,
        timeout: 10000
    });

    socket.on("connect_error", (err) => {
        console.error("Erro de Conexão WebSocket:", err.message);
        if (mainWindow) {
            mainWindow.webContents.send('status-conexao', 'erro');
            mainWindow.webContents.send('nova-impressao', {
                id: Date.now(),
                mensagem: `⚠️ Erro de conexão: ${err.message}. Tentando reconectar...`,
                status: 'pendente'
            });
        }
    });

    socket.on("error", (err) => {
        console.error("Erro Fatal Socket:", err);
    });

    socket.on("connect", () => {
        console.log("Conectado ao Servidor na conta do Restaurante:", restauranteIdLocal);
        if (mainWindow) mainWindow.webContents.send('status-conexao', 'conectado');
        socket.emit("joinRestaurante", restauranteIdLocal);
        // AO CONECTAR: Busca tudo que ficou pendente enquanto estava offline ou com erro
        if (tokenLocal && restauranteIdLocal) {
            sincronizarPendentes(tokenLocal, restauranteIdLocal);
        }
    });

    socket.on("disconnect", () => {
        console.log("Desconectado do Servidor!");
        if (mainWindow) mainWindow.webContents.send('status-conexao', 'desconectado');
    });

    socket.on("novoPedido", async (dadosDoPedido) => {
        console.log("Novo pedido recebido via Socket...");
        await processarImpressaoPedido(dadosDoPedido, tokenLocal, false);
    });

    socket.on("imprimirNFCe", async (pedido) => {
        console.log("Comando de automática NFC-e recebido...");
        const printerCaixa = mapeamentoImpressoras['caixa'];
        if (printerCaixa) {
            await imprimirDANFE(pedido, printerCaixa);
        }
    });
});

// Listener Manual de Sincronização
ipcMain.on('sincronizar-manual', (event, data) => {
    const forceCaixa = data ? data.forceCaixa : false;
    console.log(`Recebido comando manual de sincronização (Force Caixa: ${forceCaixa}).`);
    if (tokenLocal && restauranteIdLocal) {
        sincronizarPendentes(tokenLocal, restauranteIdLocal, forceCaixa);
    } else {
        console.warn("Sincronização manual impossível: Sem credenciais.");
    }
});

// Listener para Re-impressão Manual do Caixa (botão no log)
ipcMain.on('reimprimir-caixa-manual', async (event, pedidoId) => {
    const pedido = cacheUltimosPedidos.get(pedidoId);
    const printerCaixa = mapeamentoImpressoras['caixa'];

    if (pedido && printerCaixa) {
        console.log(`[MANUAL] Reimprimindo Via do Caixa para Pedido ${pedidoId}`);
        await imprimirVia(pedido, pedido.itens, printerCaixa, "REIMPRESSÃO - VIA DO CAIXA", false);
    } else {
        console.error(`[MANUAL] Falha ao reimprimir: Pedido ${pedidoId} não encontrado no cache ou impressora não configurada.`);
    }
});

/**
 * Busca itens ativos que ainda não foram impressos no Banco de Dados
 */
async function sincronizarPendentes(token, restauranteId, forceCaixa = false) {
    try {
        console.log(`[SYNC] Buscando pendentes para restaurante: ${restauranteId}`);
        const response = await fetch(`https://api.dasheats.com.br/pedido/pendentes/impressao/${restauranteId}`, {
            headers: { "Authorization": `Bearer ${token}` }
        });

        if (!response.ok) {
            console.error(`[SYNC] Erro na API: ${response.status}`);
            return;
        }

        const pedidos = await response.json();
        console.log(`[SYNC] Encontrados ${pedidos.length} pedidos com pendências.`);

        for (const pedido of pedidos) {
            // isSync = true para evitar re-imprimir via do caixa no sincronismo automático/manual
            await processarImpressaoPedido(pedido, token, true, forceCaixa);
        }

        if (mainWindow) {
            mainWindow.webContents.send('nova-impressao', {
                id: Date.now(),
                mensagem: `🔄 Sincronização concluída. ${pedidos.length} pedidos verificados.`,
                status: 'sucesso'
            });
        }
    } catch (err) {
        console.error("[SYNC] Falha ao sincronizar:", err);
    }
}

/**
 * Processa um pedido específico, filtrando o que deve ser impresso em cada setor
 */
async function processarImpressaoPedido(dadosDoPedido, token, isSync = false, forceCaixa = false) {
    const pedidoId = dadosDoPedido.id;
    const codigoPedido = dadosDoPedido.codigo || `#${pedidoId}`;

    // 1. Filtrar apenas itens que ainda NÃO foram impressos
    let itensNovos = dadosDoPedido.itens.filter(item => !item.impresso);
    if (itensNovos.length === 0) return;

    const temItensImpressos = dadosDoPedido.itens.some(item => item.impresso);
    const idLocal = Date.now();

    if (mainWindow) {
        mainWindow.webContents.send('nova-impressao', {
            id: idLocal,
            mensagem: `📄 Pedido ${codigoPedido} - ${isSync ? 'Sincronizando...' : 'Distribuindo itens...'}`,
            status: 'pendente'
        });
    }

    // 2. Agrupar itens por Setor
    const itensPorSetor = {};
    const itensSemProducao = [];
    let avisosConfiguracao = "";

    itensNovos.forEach(item => {
        const sId = item.setorId ? item.setorId.toString() : 'sem_setor';
        const printerSetor = mapeamentoImpressoras[sId];

        // Só entra em itensPorSetor se existir uma impressora configurada e ela não for "vazia"
        if (item.setorId && printerSetor && printerSetor !== "") {
            if (!itensPorSetor[sId]) itensPorSetor[sId] = [];
            itensPorSetor[sId].push(item);
        } else {
            itensSemProducao.push(item);
            // Se o item tem um setor mas não tem impressora (ou está desativada), avisamos
            if (item.setorId) {
                const nomeSetor = item.setor ? item.setor.nome : `Setor #${item.setorId}`;
                avisosConfiguracao += `⚠️ ${nomeSetor} s/ Imp. `;
            }
        }
    });

    const itensSincronizar = new Set();
    let logMensagem = `<strong>PEDIDO ${codigoPedido}</strong>`;
    let teveErroGeral = (avisosConfiguracao !== "");
    if (avisosConfiguracao) logMensagem += `<br>• ${avisosConfiguracao}`;

    // 3. Imprimir Vias de Produção
    for (const [setorId, itens] of Object.entries(itensPorSetor)) {
        const printerName = mapeamentoImpressoras[setorId];
        console.log(`[PRINT] Enviando setor ${setorId} para ${printerName}...`);

        if (mainWindow) {
            mainWindow.webContents.send('nova-impressao', {
                id: idLocal,
                mensagem: `📄 Pedido ${codigoPedido} - Enviando para Produção (${printerName})...`,
                status: 'pendente'
            });
        }

        const sucesso = await imprimirVia(dadosDoPedido, itens, printerName, "PEDIDO PARA PRODUÇÃO", temItensImpressos);

        if (sucesso) {
            itens.forEach(i => itensSincronizar.add(i.id));
            logMensagem += `<br>• ✅ Setor OK`;
        } else {
            logMensagem += `<br>• ❌ Erro Setor (${printerName})`;
            teveErroGeral = true;
        }
        // Aguarda um pouco entre setores para não sobrecarregar o spooler
        await new Promise(r => setTimeout(r, 600));
    }

    // 4. Imprimir Via do Caixa
    const printerCaixa = mapeamentoImpressoras['caixa'];
    let sucessosCaixa = 0;
    let numVias = 0;

    // MODIFICADO: Só imprime no caixa se NÃO for sincronismo E (deu erro na produção OU tem itens sem setor/impressora)
    const deveImprimirNoCaixa = !isSync && (teveErroGeral || itensSemProducao.length > 0);

    if (printerCaixa && deveImprimirNoCaixa) {
        numVias = (forceCaixa || !isSync) ? (mapeamentoImpressoras['viasCaixa'] || 1) : 1;

        if (mainWindow) {
            mainWindow.webContents.send('nova-impressao', {
                id: idLocal,
                mensagem: `📄 Pedido ${codigoPedido} - Enviando para o Caixa (${printerCaixa})...`,
                status: 'pendente'
            });
        }

        for (let i = 0; i < numVias; i++) {
            const ok = await imprimirVia(dadosDoPedido, itensNovos, printerCaixa, "VIA DO CAIXA", temItensImpressos);
            if (ok) sucessosCaixa++;
            if (numVias > 1) await new Promise(r => setTimeout(r, 600));
        }

        if (sucessosCaixa > 0) {
            logMensagem += `<br>• ✅ Caixa OK`;
            // Itens que NÃO POSSUEM setor (itens de balcão/gerais) são marcados como impressos
            // pois o Caixa é o destino final e único deles.
            itensSemProducao.forEach(item => {
                if (!item.setorId) {
                    itensSincronizar.add(item.id);
                }
            });
        } else {
            logMensagem += `<br>• ❌ Erro Caixa`;
            teveErroGeral = true;
        }
    } else if (itensSemProducao.length > 0 && !printerCaixa) {
        logMensagem += `<br>• ⚠️ Sem Imp. p/ Caixa`;
    }

    // 5. Marcar como impresso no DB apenas o que realmente teve destino de produção ou balcão
    if (itensSincronizar.size > 0) {
        try {
            if (mainWindow) {
                mainWindow.webContents.send('nova-impressao', {
                    id: idLocal,
                    mensagem: `📄 Pedido ${codigoPedido} - Finalizando no servidor...`,
                    status: 'pendente'
                });
            }

            const resStatus = await fetch("https://api.dasheats.com.br/itempedido/batch/impresso", {
                method: "PATCH",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
                body: JSON.stringify({ ids: Array.from(itensSincronizar).map(id => id.toString()) }),
                signal: AbortSignal.timeout(10000) // Timeout de 10s para a atualização
            });

            if (!resStatus.ok) {
                console.error("[SYNC_ERROR] Falha ao atualizar status no servidor");
                logMensagem += `<br>• ⚠️ Erro ao atualizar servidor`;
            }
        } catch (syncErr) {
            console.error("Erro ao sincronizar com DB:", syncErr);
            logMensagem += `<br>• ⚠️ Erro de conexão com servidor`;
        }
    }

    // 6. Atualizar Interface com botão de re-impressão (passando o pedidoId)
    if (mainWindow) {
        // Armazena no cache para permitir re-impressão manual se der erro
        cacheUltimosPedidos.set(pedidoId, dadosDoPedido);
        // Limpa cache se ficar muito grande (mantém os últimos 50)
        if (cacheUltimosPedidos.size > 50) {
            const firstKey = cacheUltimosPedidos.keys().next().value;
            cacheUltimosPedidos.delete(firstKey);
        }

        mainWindow.webContents.send('status-impressao-update', {
            id: idLocal,
            pedidoId: pedidoId,
            status: teveErroGeral ? 'erro' : 'sucesso',
            falhaCaixa: (printerCaixa && sucessosCaixa < numVias),
            mensagem: logMensagem
        });
    }
}

/**
 * Helper de Impressão (Electron BrowserView)
 */
/**
 * Helper de Impressão (Electron BrowserView)
 */
async function imprimirVia(pedido, itens, printerName, viaTitulo, isAcrescimo) {
    return new Promise(async (resolve) => {
        let printWindow = null;
        let timeoutSeguranca = null;

        const finalizar = (resultado) => {
            if (timeoutSeguranca) clearTimeout(timeoutSeguranca);
            if (printWindow) {
                try { printWindow.close(); } catch (e) { }
            }
            resolve(resultado);
        };

        try {
            printWindow = new BrowserWindow({
                show: false,
                webPreferences: {
                    nodeIntegration: true,
                    contextIsolation: false
                }
            });

            // Timeout global de 15 segundos para esta via
            timeoutSeguranca = setTimeout(() => {
                console.error(`[PRINT_TIMEOUT] A impressora ${printerName} não respondeu em 15s.`);
                finalizar(false);
            }, 15000);

            const tituloStatus = isAcrescimo ? `ACRÉSCIMO - ${viaTitulo}` : viaTitulo;
            const codigoPedido = pedido.codigo || `#${pedido.id}`;

            let itensHtml = "";
            let subtotalVia = 0;
            itens.forEach(item => {
                const nomeProduto = item.nome || (item.cardapio && item.cardapio.nome) || `Item #${item.cardapioId}`;
                const valor = item.precoUnitario || 0;
                subtotalVia += (Number(valor) * Number(item.quantidade));

                itensHtml += `<tr>
                    <td style="text-align: left"><b>${item.quantidade}x ${nomeProduto}</b></td>
                    <td style="text-align: right">R$ ${Number(valor).toFixed(2)}</td>
                </tr>`;
                if (item.observacao) {
                    itensHtml += `<tr><td colspan="2" style="font-size: 12px; padding-left: 10px; font-style: italic;">Obs: ${item.observacao}</td></tr>`;
                }
            });

            const htmlCupom = `
                <html>
                    <head>
                        <meta charset="UTF-8">
                        <style>
                            body { font-family: monospace; font-size: 12px; width: 280px; margin: 0; padding: 5px;}
                            .center { text-align: center; }
                            .divider { border-bottom: 1px dashed #000; margin: 5px 0; }
                            table { width: 100%; border-collapse: collapse; }
                            .header-tag { background: #000; color: #fff; padding: 2px 5px; font-weight: bold; font-size: 11px; }
                        </style>
                    </head>
                    <body>
                        <div class="center">
                            <span class="header-tag">${tituloStatus}</span><br>
                            <strong style="font-size: 16px;">DASH EATS</strong>
                        </div>
                        <div class="divider"></div>
                        <p><strong>PEDIDO:</strong> ${codigoPedido}</p>
                        <p><strong>CLIENTE:</strong> ${pedido.clienteNome || (pedido.mesa ? `MESA ${pedido.mesa.identificador}` : (pedido.comanda ? `COMANDA ${pedido.comanda.codigo}` : 'Balcão'))}</p>
                        <div class="divider"></div>
                        <table>${itensHtml}</table>
                        <div class="divider"></div>
                        <p style="text-align: right;"><strong>SUBTOTAL VIA: R$ ${subtotalVia.toFixed(2)}</strong></p>
                        ${viaTitulo === "VIA DO CAIXA" ? `<p style="text-align: right; font-size: 11px; margin-top: 5px;">TOTAL ACUMULADO: R$ ${Number(pedido.total).toFixed(2)}</p>` : ''}
                        <div class="divider"></div>
                        <p style="text-align: right; font-size: 9px;">${new Date().toLocaleString()}</p>
                    </body>
                </html>
            `;

            printWindow.webContents.on('did-fail-load', (e, code, desc) => {
                console.error("[PRINT_LOAD_FAIL]", code, desc);
                finalizar(false);
            });

            printWindow.webContents.on('did-finish-load', async () => {
                // Pequeno atraso para garantir renderização antes do print
                await new Promise(r => setTimeout(r, 800));

                printWindow.webContents.print({
                    silent: true,
                    printBackground: true,
                    deviceName: printerName,
                    margins: { marginType: 'none' }, // Garante que o Windows não reclame de margens vazias
                    pageSize: 'A4'                  // Força um tamanho para evitar erro de "página vazia" no PDF
                }, (success, errorType) => {
                    if (!success) {
                        console.error(`[PRINT_ERROR] Impressora: ${printerName}, Erro:`, errorType);
                    } else {
                        console.log(`[PRINT_SUCCESS] Comando enviado para ${printerName}`);
                    }
                    // Delay para fechar a janela após o spooler do Windows receber os dados
                    setTimeout(() => finalizar(success), 1000);
                });
            });

            await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlCupom)}`);

        } catch (err) {
            console.error("Erro no processo de imprimirVia:", err);
            finalizar(false);
        }
    });
}

/**
 * Helper to print Danfe NFC-e (Thermal Receipt)
 */
async function imprimirDANFE(pedido, printerName) {
    return new Promise(async (resolve) => {
        try {
            const nf = pedido.notaFiscal;
            if (!nf) return resolve(false);

            const restaurante = pedido.restaurante;
            const config = restaurante.configFiscal || {};
            const endereco = restaurante.endereco || {};
            const items = pedido.itens || [];

            let printWindow = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });

            let itensHtml = "";
            items.forEach((item, idx) => {
                const nome = item.cardapio?.nome || "Item";
                itensHtml += `
                    <tr>
                        <td colspan="2" style="text-align: left; padding-top: 5px;">${String(idx + 1).padStart(3, '0')} ${normalizeString(nome).substring(0, 30)}</td>
                    </tr>
                    <tr>
                        <td style="text-align: left">${item.quantidade} UN X R$ ${Number(item.precoUnitario).toFixed(2)}</td>
                        <td style="text-align: right">R$ ${(item.quantidade * item.precoUnitario).toFixed(2)}</td>
                    </tr>
                `;
            });

            // Generate QR Code URL
            const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(nf.qrcode || nf.chaveAcesso)}`;

            const htmlDanfe = `
                <html>
                    <head>
                        <style>
                            body { font-family: 'Courier New', monospace; font-size: 10px; width: 280px; margin: 0; padding: 10px; line-height: 1.2;}
                            .center { text-align: center; }
                            .divider { border-bottom: 1px dashed #000; margin: 5px 0; }
                            .bold { font-weight: bold; }
                            table { width: 100%; border-collapse: collapse; }
                            .qr-container { margin: 10px 0; }
                        </style>
                    </head>
                    <body>
                        <div class="center">
                            <span class="bold" style="font-size: 12px;">${normalizeString(restaurante.nome)}</span><br>
                            ${normalizeString(config.razaoSocial || "")}<br>
                            CNPJ: ${config.cnpj || ""}<br>
                            IE: ${config.inscricaoEstadual || "ISENTO"}<br>
                            ${normalizeString(endereco.logradouro || "")}, ${endereco.numero || ""}<br>
                            ${normalizeString(endereco.bairro || "")} - ${normalizeString(endereco.cidade || "")}/${endereco.estado || ""}
                        </div>
                        <div class="divider"></div>
                        <div class="center">
                            <span class="bold">DANFE NFC-e - Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica</span>
                            ${pedido.clienteCPF ? `<br>CPF DO CONSUMIDOR: ${pedido.clienteCPF}` : '<br>CONSUMIDOR NÃO IDENTIFICADO'}
                            ${nf.status === 'contingencia' ? '<br><span class="bold" style="font-size: 11px;">EMITIDA EM CONTINGÊNCIA</span>' : ''}
                        </div>
                        <div class="divider"></div>
                        <table>
                            <tr><th style="text-align: left">QTD UN VL.UNIT</th><th style="text-align: right">VL.TOTAL</th></tr>
                            ${itensHtml}
                        </table>
                        <div class="divider"></div>
                        <div style="display: flex; justify-content: space-between;">
                            <span class="bold">QTD. TOTAL DE ITENS</span>
                            <span>${items.length}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span class="bold">VALOR TOTAL R$</span>
                            <span class="bold">${Number(pedido.total).toFixed(2)}</span>
                        </div>
                        <div class="divider"></div>
                        <div class="center">
                            <span class="bold">MENSAGENS FISCAIS</span><br>
                            Número ${nf.numero} Série ${nf.serie}<br>
                            Emissão ${new Date(pedido.criadoEm || pedido.createdAt || Date.now()).toLocaleString()}<br>
                            ${nf.status === 'autorizada' ? `Protocolo: ${nf.protocolo}` : '<b>Pendente Transmissão</b>'}
                        </div>
                        <div class="divider"></div>
                        <div class="center">
                            Consulte pela Chave de Acesso em:<br>
                            <span style="font-size: 8px;">${nf.chaveAcesso}</span>
                        </div>
                        <div class="center qr-container">
                            <img src="${qrImageUrl}" width="120" height="120" />
                        </div>
                        <div class="divider"></div>
                        <div class="center" style="font-size: 8px;">DASH EATS - v1.0</div>
                    </body>
                </html>
            `;

            printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlDanfe)}`);

            printWindow.webContents.on('did-finish-load', async () => {
                await new Promise(r => setTimeout(r, 800)); // Wait for QR code image to load
                printWindow.webContents.print({
                    silent: true,
                    printBackground: true,
                    deviceName: printerName,
                    margins: { marginType: 'none' },
                    pageSize: 'A4'
                }, () => {
                    setTimeout(() => {
                        printWindow.close();
                        resolve(true);
                    }, 1000);
                });
            });
        } catch (err) {
            console.error("Erro no imprimirDANFE:", err);
            resolve(false);
        }
    });
}

/**
 * Corrige acentuação para impressora térmica antiga (opcional se a fonte suportar UTF-8)
 */
function normalizeString(str) {
    if (!str) return "";
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
}

// IPC: Testar impressão (usa a do caixa)
ipcMain.on('imprimir-teste', async () => {
    const printerName = mapeamentoImpressoras['caixa'];
    if (!printerName) return;

    const pedidoMock = { id: 0, codigo: "TESTE-001", clienteNome: "Teste de Impressora", total: 10.00 };
    const itensMock = [{ nome: "Item de Teste", quantidade: 1, precoUnitario: 10.00 }];

    await imprimirVia(pedidoMock, itensMock, printerName, "IMPRESSÃO DE TESTE", false);
});
