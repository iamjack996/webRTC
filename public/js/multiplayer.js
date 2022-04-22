let iceServer
let vm = new Vue({
    el: '#v-table',
    data: {
        socket: {},
        room: {
            count: 0
        },
        videoList: [],
        msgs: []
    },
    created() {
        // console.log('created')

        axios
            .get('/configs')
            .then(res => {
                console.log(res.data)
                Vue.nextTick()
                    .then(() => {
                        let { env, port, iceServer: iceHost } = res.data

                        let protocol = env === 'local' ? 'http' : 'https'
                        let socketPort = env === 'local' ? (':' + port) : ''
                        // setTimeout(() => 
                        this.socket = io(protocol + '://' + window.location.hostname + socketPort)
                        // }, 2000)

                        iceServer = iceHost
                    })
            })
            .catch(error => {
                console.log(error)
            })
            .finally(connectIO)
    },
    methods: {
        sendMessage() {
            let text = msgInput.value
            if (text.length < 1) return

            this.socket.emit('send message', text, msgs => vm.msgs = msgs)

            msgInput.value = ''
        },
        forDev() {
            this.socket.emit('dev test', data => {
                console.log(data)
                console.log(JSON.parse(data.rooms))
            })
        }
    },
    filters: {}
})

// video 標籤
const localVideo = document.querySelector('video#localVideo')

// button 標籤
const startBtn = document.querySelector('button#startBtn')
const leaveBtn = document.querySelector('button#leaveBtn')
const audioBtn = document.querySelector('button#audioBtn')
const videoBtn = document.querySelector('button#videoBtn')
const raiseHandBtn = document.querySelector('button#raiseHandBtn')
const shareBtn = document.querySelector('button#shareBtn')

// 切換設備
const audioInputSelect = document.querySelector('select#audioSource')
const videoSelect = document.querySelector('select#videoSource')
const selectors = [audioInputSelect, videoSelect]

const msgInput = document.querySelector('input#message')

let localStream
let peerConn = []
let streamOutput = { audio: true, video: true }
let infos = { hand: false }
let firstLoad = true

const url = new URL(window.location.href)
const username = url.search.split("?user=")[1]
const room = url.pathname.split("/chat/")[1]
const remoteVideoPrefix = 'remoteVideo-'

async function connectIO() {

    vm.socket.on('new member', async data => {
        console.log(data)
        let { user, size } = data

        let emptyIndex = vm.videoList.findIndex(row => !row.show)
        emptyIndex > -1
            ? vm.videoList[emptyIndex] = {
                ...vm.videoList[emptyIndex],
                user,
                show: true
            }
            : vm.videoList.push({
                user,
                tag: remoteVideoPrefix + parseInt(size - 2),
                show: true
            })

        vm.room.count = size

        setTimeout(async () => await sendSDP(true, user), 500)
    })

    vm.socket.on('ice_candidate', async data => {
        console.log('ice')
        const candidate = new RTCIceCandidate({
            sdpMLineIndex: data.label,
            candidate: data.candidate,
        })

        if (await peerConn[data.sender]) await peerConn[data.sender].addIceCandidate(candidate)
    })

    vm.socket.on('offer', async data => {
        let { desc, sender, isRestart } = data
        console.log('offer', data, !!peerConn[sender])

        if (!peerConn[sender]) await initPeerConnection(sender)
        // 設定對方的配置
        await peerConn[sender].setRemoteDescription(desc)
        // 發送 answer
        await sendSDP(false, sender, isRestart)
    })

    vm.socket.on('answer', async data => {
        console.log('answer', data)
        let { desc, sender } = data
        // 設定對方的配置
        await peerConn[sender].setRemoteDescription(desc)
    })

    vm.socket.on('leaved', () => {
        console.log('收到 leaved')
        vm.socket.disconnect()
        closeLocalMedia()

        vm.room.count = 0
        vm.videoList = []
    })

    vm.socket.on('bye', ({ user }) => {
        console.log('收到 bye', user)

        hangup(user)
        vm.room.count--

        let index = vm.videoList.findIndex(row => row.user === user)
        vm.videoList[index].show = false
    })

    vm.socket.on('raise hand', ({ user, bool }) => {
        console.log('raise hand =>', user, bool)

        let index = vm.videoList.findIndex(row => row.user == user)
        document.querySelector('video#' + vm.videoList[index].tag)
            .classList[bool ? 'add' : 'remove']('raise-hand')
    })

    vm.socket.on('reset remote video', hangup)

    vm.socket.on('update message', data => {
        console.log(data)
        vm.msgs = data
    })

    vm.socket.on('connect_failed', err => console.log(err))
    vm.socket.on('connect_error', err => console.log(err))
}

function restartCreateOffer() {
    vm.socket.emit('reset remote video')
    hangup()

    setTimeout(() => {
        vm.videoList.forEach(remote => {
            if (remote.show) sendSDP(true, remote.user, true)
        })
    }, 150)
}

function startLocal() {
    firstLoad ? firstLoad = false : vm.socket.connect()

    setTimeout(() => {
        vm.socket.emit('join', { room, username }, res => {
            console.log(res)
            let { token, size, members, messages } = res

            vm.msgs = messages
            vm.room.count = size

            members.forEach((array, i) => {
                let [user, data] = array
                let tag = remoteVideoPrefix + parseInt(i)
                vm.videoList.push({ user, tag, show: true })

                if (data.hand) setTimeout(() => document.querySelector('video#' + tag).classList.add('raise-hand'), 300)
            })
        })
    }, 1500)
}

// 陣列換位置
function exchange(i, j, array) {
    array[i] = array.splice(j, 1, array[i])[0]
    return array
}

// 設定按鈕文字
function setBtnText() {
    audioBtn.textContent = streamOutput.audio ? '關閉麥克風' : '開啟麥克風'
    videoBtn.textContent = streamOutput.video ? '關閉視訊鏡頭' : '開啟視訊鏡頭'
    raiseHandBtn.textContent = infos.hand ? '放下' : '舉手'
}

/**
 * 取得本地串流
 */
async function createStream() {
    try {
        // 取得影音的Stream
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: true
        })

        // 提升作用域
        localStream = stream
        // 導入<video>
        localVideo.srcObject = stream
    } catch (err) {
        throw err
    }
}

/**
 * 初始化Peer連結
 */
async function initPeerConnection(user = null) {
    const configuration = {
        iceServers: [
            {
                urls: 'stun:' + iceServer,
                // urls: 'stun:stun.l.google.com:19302',
            },
        ],
    }

    if (!user) alert('error')

    console.log('Init RTC Peer Connection ::::', user)
    peerConn[user] = new RTCPeerConnection(configuration)

    // 增加本地串流
    localStream.getTracks().forEach(track => {
        peerConn[user].addTrack(track, localStream)
    })

    // 找尋到 ICE 候選位置後，送去 Server 與另一位配對
    peerConn[user].onicecandidate = e => {
        if (e.candidate) {
            console.log('發送 ICE')
            // 發送 ICE
            vm.socket.emit('ice_candidate', room, {
                label: e.candidate.sdpMLineIndex,
                id: e.candidate.sdpMid,
                candidate: e.candidate.candidate,
                user
            })
        }
    }

    let index = vm.videoList.findIndex(info => info.user == user)
    let remoteVideoTag = document.querySelector('video#' + vm.videoList[index].tag)

    // 監聽 ICE 連接狀態
    peerConn[user].oniceconnectionstatechange = (e) => {
        if (e.target.iceConnectionState === 'disconnected') {
            remoteVideoTag.srcObject = null
        }
    }

    // 監聽是否有流傳入，如果有的話就顯示影像
    peerConn[user].onaddstream = ({ stream }) => {
        // 接收流並顯示遠端視訊
        remoteVideoTag.srcObject = stream
    }
}

/**
 * 處理信令
 * @param {Boolean} isOffer 是 offer 還是 answer
 */
async function sendSDP(isOffer, user, isRestart = false) {
    try {
        if (!peerConn[user]) {
            await initPeerConnection(user)
        }

        // 創建SDP信令
        let offerOptions = {
            offerToReceiveAudio: true, // 是否傳送聲音流給對方
            offerToReceiveVideo: true, // 是否傳送影像流給對方
        }
        if (isRestart) {
            isOffer ? offerOptions.iceRestart = true
                : offerOptions = {}
        }

        const localSDP = await peerConn[user][isOffer ? 'createOffer' : 'createAnswer'](offerOptions)

        // 設定本地SDP信令
        await peerConn[user].setLocalDescription(localSDP)

        // 寄出SDP信令
        let e = isOffer ? 'offer' : 'answer'
        vm.socket.emit(e, room, { user, desc: peerConn[user].localDescription, isRestart })
    } catch (err) {
        throw err
    }
}

/**
 * 關閉自己的視訊
 */
function closeLocalMedia() {
    if (localStream && localStream.getTracks()) {
        localStream.getTracks().forEach((track) => {
            track.stop()
        })
    }
    localStream = null
}

/**
 * 掛掉電話
 */
function hangup(user = null) {
    try {
        if (user) {
            if (peerConn[user]) {
                peerConn[user].close()
                // peerConn[user] = null
                delete peerConn[user]
            }
        } else {
            if (Object.keys(peerConn).length) {
                Object.values(peerConn).forEach(peer => {
                    if (peer) peer.close()
                })
                peerConn = []
            }
        }
    } catch (e) {
        throw e
    }
}

/**
 * 初始化
 */
async function init() {
    await createStream()

    startLocal()

    setButtonState(true)
    streamOutput = { audio: true, video: true }

    if ((navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices)) {
        shareBtn.disabled = false
    } else {
        console.log('getDisplayMedia is not supported')
    }
    setBtnText()
}

leaveBtn.onclick = () => {
    if (vm.socket) {
        vm.socket.emit('leave')
    }
    hangup()
    closeLocalMedia()

    setButtonState(false)
    shareBtn.disabled = true

    infos.hand = false
    localVideo.classList.remove('raise-hand')
    setBtnText()
}

// 將讀取到的設備加入到 select 標籤中
function gotDevices(deviceInfos) {
    // Handles being called several times to update labels. Preserve values.
    const values = selectors.map((select) => select.value)
    selectors.forEach((select) => {
        while (select.firstChild) {
            select.removeChild(select.firstChild)
        }
    })
    for (let i = 0; i !== deviceInfos.length; ++i) {
        const deviceInfo = deviceInfos[i]
        const option = document.createElement('option')
        option.value = deviceInfo.deviceId
        if (deviceInfo.kind === 'audioinput') {
            option.text =
                deviceInfo.label || `microphone ${audioInputSelect.length + 1}`
            audioInputSelect.appendChild(option)
        } else if (deviceInfo.kind === 'videoinput') {
            option.text = deviceInfo.label || `camera ${videoSelect.length + 1}`
            videoSelect.appendChild(option)
        } else {
            console.log('Some other kind of source/device: ', deviceInfo)
        }
    }
    selectors.forEach((select, selectorIndex) => {
        if (
            Array.prototype.slice
                .call(select.childNodes)
                .some((n) => n.value === values[selectorIndex])
        ) {
            select.value = values[selectorIndex]
        }
    })
}

//更新本地串流輸出狀態
function setSelfStream() {
    localStream.getAudioTracks().forEach((item) => {
        item.enabled = streamOutput.audio
    })
    localStream.getVideoTracks().forEach((item) => {
        item.enabled = streamOutput.video
    })
}

//設定本地串流開關狀態
function handleStreamOutput(e) {
    const { name } = e.target

    streamOutput = {
        ...streamOutput,
        [name]: !streamOutput[name],
    }
    setBtnText()
    setSelfStream()
}

function raiseHand() {
    infos = {
        ...infos,
        hand: !infos.hand
    }
    localVideo.classList[infos.hand ? 'add' : 'remove']('raise-hand')
    setBtnText()

    vm.socket.emit('raise hand', infos.hand)
}

function switchShareScreen() {
    navigator.mediaDevices.getDisplayMedia({ video: true })
        .then(stream => {
            // leaveBtn.click()

            // setTimeout(() => {
            //     localStream = stream
            //     localVideo.srcObject = stream

            //     stream.getVideoTracks()[0].addEventListener('ended', () => {
            //         console.log('已停止分享螢幕')
            //         shareBtn.disabled = false

            //         // 切回原本鏡頭
            //         leaveBtn.click()
            //         init()
            //     })

            //     startLocal()
            // setButtonState(true)
            //     streamOutput = { audio: true, video: true }
            //     setBtnText()
            // }, 500)


            // *** new ***
            localStream = stream
            localVideo.srcObject = stream

            restartCreateOffer()

            shareBtn.disabled = true
            audioInputSelect.disabled = true
            videoSelect.disabled = true

            stream.getVideoTracks()[0].addEventListener('ended', async () => {
                console.log('已停止分享螢幕')
                // 切回原本鏡頭
                await createStream()
                restartCreateOffer()

                shareBtn.disabled = false
                audioInputSelect.disabled = false
                videoSelect.disabled = false
            })

        }, err => {
            console.log(err)
        })
}

// 讀取設備
navigator.mediaDevices
    .enumerateDevices()
    .then(gotDevices)
    .catch((err) => {
        console.error('Error happens:', err)
    })

audioInputSelect.onchange = () => {
    vm.videoList.forEach(remote => {
        if (remote.show) switchDevice(true, remote.user)
    })
}
videoSelect.onchange = () => {
    vm.videoList.forEach(remote => {
        if (remote.show) switchDevice(false, remote.user)
    })
}

async function switchDevice(isAudio, user) {
    if (!peerConn[user]) return
    const audioSource = audioInputSelect.value
    const videoSource = videoSelect.value
    const constraints = {
        audio: { deviceId: audioSource ? { exact: audioSource } : undefined },
        video: { deviceId: videoSource ? { exact: videoSource } : undefined },
    }
    const stream = await navigator.mediaDevices.getUserMedia(constraints)
    let track = stream[isAudio ? 'getAudioTracks' : 'getVideoTracks']()[0]
    let sender = peerConn[user].getSenders().find(function (s) {
        return s.track.kind == track.kind
    })
    console.log('found sender:', sender)
    sender.replaceTrack(track)

    localStream = stream
    localVideo.srcObject = stream
}

startBtn.onclick = init
audioBtn.onclick = handleStreamOutput
videoBtn.onclick = handleStreamOutput
raiseHandBtn.onclick = raiseHand
shareBtn.onclick = switchShareScreen

init()

function setButtonState(isStart) {
    startBtn.disabled = isStart
    leaveBtn.disabled = !isStart
    audioBtn.disabled = !isStart
    videoBtn.disabled = !isStart
    raiseHandBtn.disabled = !isStart
}

leaveBtn.disabled = true
audioBtn.disabled = true
videoBtn.disabled = true
raiseHandBtn.disabled = true
shareBtn.disabled = true