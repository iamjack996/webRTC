require('dotenv').config()
const express = require('express')
const app = express()
const http = require('http').createServer(app)
const port = process.env.PORT
const { v4: uuidv4 } = require('uuid')
const path = require('path')

app.set('views', path.join(__dirname, 'views'))
app.set('view engine', 'ejs')

app.get('/chat/:id', (req, res) => {
    res.render('multiplayer')
})
app.get('/configs', (req, res) => {
    return res.status(200).json({ port, env: process.env.NODE_ENV, iceServer: process.env.ICE_SERVER })
})
app.use('/', express.static(__dirname + '/public/'))

const io = require('socket.io')(http, {
    cors: true,
    pingTimeout: 30000,
    pingInterval: 32000
})

let roomMembers = {} // 儲存房間成員資訊
let sockets = []
let messages = {}

io.on('connection', (socket) => {

    // join
    socket.on('join', (data, fn) => {
        let { room, username } = data
        let user = uuidv4()

        socket.join(room)

        if (!roomMembers[room]) roomMembers[room] = {}
        let members = Object.entries(roomMembers[room]) // room's old members

        roomMembers[room][user] = {
            socketId: socket.id,
            name: username,
            hand: false
        }
        sockets[socket.id] = { room, user }

        let size = Object.keys(roomMembers[room]).length
        // let size = io.sockets.adapter.rooms.get(room) ? io.sockets.adapter.rooms.get(room).size : 0
        socket.to(room).emit('new member', { user, size, msg: '新成員加入' })

        console.log('join :', user, 'socket.id : ', socket.id)

        fn({ token: user, size, members, messages: messages[room] || [] })
    })

    // 轉傳 Offer
    socket.on('offer', (room, data) => {
        let { user, desc, isRestart } = data
        if (roomMembers[room] ? roomMembers[room][user] : false) {
            sender = sockets[socket.id].user
            socket.to(roomMembers[room][user].socketId).emit('offer', { desc, sender, isRestart })
        }
    })

    // 轉傳 Answer
    socket.on('answer', (room, data) => {
        let { user, desc } = data
        if (roomMembers[room] ? roomMembers[room][user] : false) {
            sender = sockets[socket.id].user
            socket.to(roomMembers[room][user].socketId).emit('answer', { desc, sender })
        }
    })

    // 交換 ice candidate
    socket.on('ice_candidate', (room, data) => {
        let { user } = data
        if (roomMembers[room] ? roomMembers[room][user] : false) {
            data = {
                ...data,
                sender: sockets[socket.id].user
            }
            socket.to(roomMembers[room][user].socketId).emit('ice_candidate', data)
        }
    })

    socket.on('leave', () => {
        if (sockets[socket.id]) {
            let { room, user } = sockets[socket.id]

            if (roomMembers[room][user].hand) {
                socket.to(room).emit('raise hand', { user, bool: false })
            }

            delete roomMembers[room][user]
            delete sockets[socket.id]

            socket.to(room).emit('bye', { user }) // to 其他成員
            socket.emit('leaved') // to 自己

            checkRoomHasClean(room)
        }
    })

    const checkRoomHasClean = (room) => {
        if (roomMembers[room]) {
            let size = Object.keys(roomMembers[room]).length
            if (size < 1) {
                delete messages[room]
                delete roomMembers[room]
            }
        }
    }

    socket.on('raise hand', bool => {
        if (sockets[socket.id]) {
            let { room, user } = sockets[socket.id]
            roomMembers[room][user].hand = bool
            socket.to(room).emit('raise hand', { user, bool })
        }
    })

    socket.on('reset remote video', () => {
        if (sockets[socket.id]) {
            let { room, user } = sockets[socket.id]
            socket.to(room).emit('reset remote video', user)
        }
    })

    socket.on('send message', (msg, fn) => {
        if (sockets[socket.id]) {
            let { room, user } = sockets[socket.id]
            let { name } = roomMembers[room][user]

            if (!messages[room]) messages[room] = []
            messages[room].push({
                name,
                time: new Date().toLocaleString('zh-TW'), // , { timeZone: 'Asia/Taipei' }
                text: msg
            })

            socket.to(room).emit('update message', messages[room])

            fn(messages[room])
        }
    })

    socket.on('disconnect', msg => {
        console.log('disconnect socket.id:', socket.id, msg)
        if (sockets[socket.id]) {
            let { room, user } = sockets[socket.id]
            console.log('disconnect :', roomMembers[room][user].name)

            console.log('org hand :', roomMembers[room][user].hand)
            if (roomMembers[room][user].hand) {
                socket.to(room).emit('raise hand', { user, bool: false })
            }

            delete roomMembers[room][user]
            delete sockets[socket.id]

            socket.to(room).emit('bye', { user }) // to 其他成員
            socket.emit('leaved') // to 自己

            console.log(roomMembers[room])

            setTimeout(() => checkRoomHasClean(room), 1500)
        }
    })

    // test
    socket.on('dev test', fn => {
        console.log(roomMembers, messages)

        fn({ messages, rooms: JSON.stringify(roomMembers) })
    })

    socket.on('error', err => {
        console.log("Socket.IO Error", err)
        console.log(err.stack) // this is changed from your code in last comment
    })

    socket.on('connect_failed', err => console.log(err))
    socket.on('connect_error', err => console.log(err))

})

http.listen(port, () => {
    console.log(`Server running in ${port}`)
})
