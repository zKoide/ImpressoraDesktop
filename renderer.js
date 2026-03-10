const { ipcRenderer } = require('electron');

// 0. Ao iniciar, carregar email e senha salvos se existirem
document.addEventListener('DOMContentLoaded', () => {
    const saved = localStorage.getItem('remembered_credentials');
    if (saved) {
        const { email, senha } = JSON.parse(saved);
        document.getElementById('email').value = email;
        document.getElementById('senha').value = senha;
        document.getElementById('lembrar-me').checked = true;
    }
});

// 1. Ao abrir o App, checar se já tem Token salvo no cache (localStorage)
window.onload = async () => {
    const credenciaisSalvas = localStorage.getItem('credenciais_dash_eats');

    if (credenciaisSalvas) {
        let credenciais = JSON.parse(credenciaisSalvas);

        // Se temos um refresh token, vamos obter um token zeradinho pra não tomar disconnect no meio do dia
        if (credenciais.refreshToken) {
            document.getElementById('erro-login').innerText = "Restaurando sessão...";
            const resposta = await ipcRenderer.invoke('renovar-login-api', credenciais.refreshToken);

            if (resposta.sucesso) {
                // Atualiza o cache com os novos tokens
                credenciais.token = resposta.token;
                credenciais.refreshToken = resposta.refreshToken;
                localStorage.setItem('credenciais_dash_eats', JSON.stringify(credenciais));

                abrirTelaDeImpressaoEConectar(credenciais);
            } else {
                // Se der erro ao renovar (ex: usuário deletado ou expirou o maximo), foca em fazer ele logar de novo
                fazerLogout();
                document.getElementById('erro-login').innerText = "Sessão expirada. Faça login novamente.";
            }
        } else {
            // Conta antiga que logou antes de botarmos a atualização (usa o token normal por enquanto)
            abrirTelaDeImpressaoEConectar(credenciais);
        }
    }
};

// 2. Função disparada pelo Botão "Conectar Impressora"
async function fazerLogin() {
    const email = document.getElementById('email').value;
    const senha = document.getElementById('senha').value;
    const msgErro = document.getElementById('erro-login');

    if (!email || !senha) {
        msgErro.innerText = "Preencha e-mail e senha!";
        return;
    }

    msgErro.innerText = "Conectando...";

    // Chama a função do Node (main.js) para fazer o Login via API de forma invisível
    const resposta = await ipcRenderer.invoke('fazer-login-api', { email, senha });

    if (resposta.sucesso) {
        msgErro.innerText = "";

        // Salvar restauranteId e tokens p/ sessão atual
        const credenciais = {
            token: resposta.token,
            refreshToken: resposta.refreshToken,
            restauranteId: parseInt(resposta.restauranteId)
        };
        localStorage.setItem('credenciais_dash_eats', JSON.stringify(credenciais));

        // LEMBRAR LOGIN
        const lembrarMe = document.getElementById('lembrar-me').checked;
        if (lembrarMe) {
            localStorage.setItem('remembered_credentials', JSON.stringify({ email, senha }));
        } else {
            localStorage.removeItem('remembered_credentials');
        }

        // Pula pra tela e já chama a conexão do Socket
        abrirTelaDeImpressaoEConectar(credenciais);
    } else {
        msgErro.innerText = resposta.erro;
    }
}

// 3. Função padrão que muda de tela, inicia o WebSocket do lado do Backend
function abrirTelaDeImpressaoEConectar(credenciais) {
    document.getElementById('tela-login').classList.add('hidden');
    document.getElementById('tela-impressao').classList.remove('hidden');

    // Avisa o main.js: "Você já pode se conectar ao Socket.io agora e ouvir pedidos!"
    ipcRenderer.send('iniciar-conexao', credenciais);

    // Carrega a lista de impressoras e os setores do restaurante
    carregarConfiguracoesImpressao();
}

let listaImpressorasCache = [];
let setoresCache = [];

async function carregarConfiguracoesImpressao() {
    // 1. Obter lista de impressoras físicas do sistema
    listaImpressorasCache = await ipcRenderer.invoke('obter-impressoras');

    const mapeamentoSalvo = JSON.parse(localStorage.getItem('mapeamento_impressoras') || '{}');

    // 2. Preencher Select do Caixa
    const selectCaixa = document.getElementById('select-impressora-caixa');
    const inputVias = document.getElementById('qtd-vias-caixa');

    if (selectCaixa) {
        selectCaixa.innerHTML = '<option value="">Nenhuma (Não imprimir via do caixa)</option>';
        listaImpressorasCache.forEach(imp => {
            const option = document.createElement('option');
            option.value = imp.name;
            option.innerText = imp.name;
            if (imp.name === mapeamentoSalvo['caixa']) option.selected = true;
            selectCaixa.appendChild(option);
        });
    }

    if (inputVias && mapeamentoSalvo['viasCaixa']) {
        inputVias.value = mapeamentoSalvo['viasCaixa'];
    }

    // 3. Buscar Setores do Backend para mapeamento individual
    try {
        const creds = JSON.parse(localStorage.getItem('credenciais_dash_eats'));
        const response = await fetch(`https://api.dasheats.com.br/setor/restaurante/${creds.restauranteId}`, {
            headers: { 'Authorization': `Bearer ${creds.token}` }
        });

        if (response.ok) {
            setoresCache = await response.json();
            renderizarMapeamentoSetores(mapeamentoSalvo);
        } else {
            console.error("Falha ao buscar setores:", response.status);
        }
    } catch (err) {
        console.error("Erro na conexão para buscar setores:", err);
    }
}

function renderizarMapeamentoSetores(mapeamento) {
    const container = document.getElementById('lista-setores-mapeamento');
    if (!container) return;

    container.innerHTML = '';

    if (setoresCache.length === 0) {
        container.innerHTML = '<p style="font-size: 11px; color: var(--text-secondary);">Nenhum setor (ex: Cozinha, Bar) encontrado no Dash Eats.</p>';
    } else {
        setoresCache.forEach(setor => {
            const row = document.createElement('div');
            row.className = 'input-group';
            row.style.marginBottom = '12px';

            row.innerHTML = `
                <label style="font-size: 11px; margin-bottom: 4px;">Cópia para: <strong>${setor.nome}</strong></label>
                <select class="select-setor-imp" data-setor-id="${setor.id}" onchange="salvarMapeamento()" style="padding: 8px; font-size: 13px;">
                    <option value="">Não imprimir neste setor</option>
                    ${listaImpressorasCache.map(imp => `
                        <option value="${imp.name}" ${mapeamento[setor.id] === imp.name ? 'selected' : ''}>
                            ${imp.name}
                        </option>
                    `).join('')}
                </select>
            `;
            container.appendChild(row);
        });
    }

    // Enviar mapeamento inicial (carregado do cache) para o main.js
    ipcRenderer.send('salvar-mapeamento', mapeamento);
}

function salvarMapeamento() {
    const mapeamento = {};

    // Ler mapping do Caixa
    const valCaixa = document.getElementById('select-impressora-caixa').value;
    const qtdVias = document.getElementById('qtd-vias-caixa').value || 1;

    if (valCaixa) {
        mapeamento['caixa'] = valCaixa;
        mapeamento['viasCaixa'] = parseInt(qtdVias);
    }

    // Ler mapping dos Setores
    const selects = document.querySelectorAll('.select-setor-imp');
    selects.forEach(sel => {
        const setorId = sel.getAttribute('data-setor-id');
        if (sel.value) {
            mapeamento[setorId] = sel.value;
        }
    });

    // Salvar no local e sincronizar com o Main Process
    localStorage.setItem('mapeamento_impressoras', JSON.stringify(mapeamento));
    ipcRenderer.send('salvar-mapeamento', mapeamento);
}

function sincronizarManualmente() {
    ipcRenderer.send('sincronizar-manual', { forceCaixa: false });
}

function imprimirTeste() {
    const valCaixa = document.getElementById('select-impressora-caixa').value;
    if (!valCaixa) {
        alert('Selecione uma impressora no campo "Caixa" para testar.');
        return;
    }
    ipcRenderer.send('imprimir-teste');
}

// 4. Função para "Deslogar" ou "Trocar de Restaurante"
function fazerLogout() {
    // Apaga do cache
    localStorage.removeItem('credenciais_dash_eats');

    // Avisa o main.js que pode fechar a conexão de socket
    ipcRenderer.send('fechar-conexao');

    // Mostra tela de login novamente
    document.getElementById('tela-impressao').classList.add('hidden');
    document.getElementById('tela-login').classList.remove('hidden');
    document.getElementById('erro-login').innerText = '';

    // Se "Lembrar-me" estiver ativado, restauramos (ou não apagamos) a senha, senão apagamos
    const lembrarSalvo = localStorage.getItem('remembered_credentials');
    if (!lembrarSalvo) {
        document.getElementById('senha').value = '';
    }

    // Reseta o status visualmente
    const el = document.getElementById('status-servidor');
    el.className = 'status-badge desconectado';
    el.innerText = 'Desconectado';
}

// ----------------------------------------------------------------------
// Rotinas já existentes que recebem avisos do Main.js e alteram o layout
// ----------------------------------------------------------------------

// Atualiza a bolinha de status
ipcRenderer.on('status-conexao', (event, status) => {
    const el = document.getElementById('status-servidor');
    if (status === 'conectado') {
        el.className = 'status-badge conectado';
        el.innerText = 'Online • Pronto para imprimir';
    } else {
        el.className = 'status-badge desconectado';
        el.innerText = 'Offline • Sem conexão';
    }
});

// Atualiza a lista de pedidos na tela com status
ipcRenderer.on('nova-impressao', (event, dados) => {
    const lista = document.getElementById('lista-impressoes');

    // Removemos a mensagem inicial se ainda estiver lá
    if (lista.children[0] && lista.children[0].textContent.includes("Aguardando")) {
        lista.innerHTML = "";
    }

    const item = document.createElement('li');
    item.id = `imp-${dados.id}`;
    item.innerHTML = `
        <div style="flex: 1; line-height: 1.4;">
            <span class="msg-texto">${dados.mensagem}</span>
        </div>
        <div class="acoes-log" style="display: flex; gap: 8px; align-items: center;">
            <span class="badge-status-imp" style="font-size: 10px; padding: 2px 6px; border-radius: 4px; background: #eee;">...</span>
        </div>
    `;
    lista.prepend(item);
});

// Atualiza o status de uma impressão específica (Sucesso ou Erro)
ipcRenderer.on('status-impressao-update', (event, dados) => {
    const item = document.getElementById(`imp-${dados.id}`);
    if (!item) return;

    const texto = item.querySelector('.msg-texto');
    if (dados.mensagem) texto.innerHTML = dados.mensagem;

    const badge = item.querySelector('.badge-status-imp');
    const acoes = item.querySelector('.acoes-log');

    if (dados.status === 'sucesso') {
        badge.innerText = 'OK';
        badge.style.background = '#e6fffa';
        badge.style.color = '#2ecc71';
    } else {
        badge.innerText = 'AVISO';
        badge.style.background = '#fff5f5';
        badge.style.color = '#e74c3c';
        item.style.borderLeft = "2px solid #e74c3c";
    }

    // Exibir o ícone de re-impressão APENAS se o caixa falhou especificamente
    if (dados.falhaCaixa && dados.pedidoId && !item.querySelector('.btn-reprint')) {
        const btn = document.createElement('button');
        btn.className = 'btn-reprint';
        btn.title = 'Reimprimir Via do Caixa';
        btn.innerHTML = '🖨️';
        btn.onclick = () => {
            btn.style.opacity = '0.5';
            btn.style.pointerEvents = 'none';
            ipcRenderer.send('reimprimir-caixa-manual', dados.pedidoId);
            setTimeout(() => {
                btn.style.opacity = '1';
                btn.style.pointerEvents = 'auto';
            }, 3000);
        };
        acoes.appendChild(btn);
    }
});
