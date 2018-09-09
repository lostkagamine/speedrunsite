const config = require('./config.json');
require('express-async-errors'); // express, pls
const express = require('express');
const querystring = require('querystring');
const crypto = require('crypto');
const superagent = require('superagent');
const session = require('express-session');
const eris = require('eris');
const games = require('./games.json');
const httpErrors = {
    codes: require('./data/errorcodes.json'),
    messages: require('./data/errormsgs.json')
}
const API_ROOT = 'https://discordapp.com/api/v6'

const app = express();
const bot = new eris(config.bot.token);

app.set('view engine', 'ejs') // use ejs

app.use(express.static('static')) // set up static memes

const renderHTTPError = (req, res, status) => {
    let strs = status.toString()
    res.status(status).render('htmlerror', {
        errno: strs,
        meaning: httpErrors.codes[strs],
        errmsg: httpErrors.messages[strs]
    })
}

var sess = {
    secret: config.express.secret,
    resave: false, // idk
    saveUninitialized: false,
    cookie: {}
}

if (app.get('env') === 'production') {
    app.set('trust proxy', 1) // trust first proxy
    sess.cookie.secure = true // serve secure cookies
}

app.use(session(sess))

app.get('/', async (req, res) => {
    res.render('index');
})

app.get('/auth', async (req, res) => {
    let thing = crypto.randomBytes(20);
    let state = thing.toString('hex');
    let query = querystring.stringify({
        client_id: config.oauth.id,
        redirect_uri: config.oauth.redir,
        response_type: 'code',
        scope: config.oauth.scopes.join(' '),
        state
    })
    let url = `${API_ROOT}/oauth2/authorize?${query}`
    res.redirect(url);
})

app.get('/auth/callback', async (req, res) => {
    let data = {
        client_id: config.oauth.id,
        client_secret: config.oauth.secret,
        grant_type: 'authorization_code',
        code: req.query.code,
        redirect_uri: config.oauth.redir,
        scope: config.oauth.scopes.join(' ')
    }
    let headers = {
        'Content-Type': 'application/x-www-form-urlencoded'
    }
    try {
        let ret = await superagent.post(`${API_ROOT}/oauth2/token`).send(data).set(headers).auth(config.oauth.id, config.oauth.secret);
        let token = ret.body.token_type + ' ' + ret.body.access_token;
        req.session.tokenData = ret.body;
        req.session.token = token;
        let userRes = await superagent.get(`${API_ROOT}/users/@me`).set({'Authorization': token});
        req.session.user = userRes.body;
        res.redirect('/hello')
    } catch(e) {
        res.render('error', {
            msg: 'Error while retrieving user token.',
            error: e.stack
        })
    }
})

app.get('/hello', async (req, res) => {
    res.render('welcome', {
        user: req.session.user
    })
})

app.get('/credits', async (req, res) => {
    res.render('credits', {
        packages: require('./package.json').dependencies
    })
})

app.get('/submit', async (req, res) => {
    if (!req.session.user) res.redirect('/auth');
    try {
        let tempuser = await superagent.get(`${API_ROOT}/users/@me`).set({'Authorization': req.session.token});
        req.session.user = tempuser.body;
    } catch(e) {
        res.redirect('/auth') // reauthorize if token badde:tm:
    }
    if (config.bannedUsers.includes(req.session.user.id)) {
        renderHTTPError(req, res, 403)
    }
    res.render('submit', {
        user: req.session.user,
        games,
        success: req.query.success || false
    })
})

app.get('/api/submit', async (req, res) => {
    if (!req.session.user) renderHTTPError(req, res, 401);
    try {
        let tempuser = await superagent.get(`${API_ROOT}/users/@me`).set({'Authorization': req.session.token});
        req.session.user = tempuser.body;
    } catch(e) {
        renderHTTPError(req, res, 401) // die if token badde:tm:
    }
    if (!req.query.game || !req.query.time) renderHTTPError(req, res, 400)
    let game = games[req.query.game]
    if (!game) renderHTTPError(req, res, 400)
    await bot.createMessage(config.bot.runChannel, `<@&${config.bot.runRole}> new run by <@${req.session.user.id}> (${req.session.user.username}#${req.session.user.discriminator})\nGame: ${game.name} (${game.short})\nTime: ${req.query.time}`)
    res.redirect('/submit?success=true');
})

app.get('/error', async (req, res) => {
    throw new TypeError('testing');
})

app.get('/error/http', async (req, res) => {
    renderHTTPError(req, res, parseInt(req.query.error) || 500)
})

app.get('*', async (req, res) => {
    renderHTTPError(req, res, 404);
})

app.use(
    (err, req, res, next) => {
        res.status(500).render('error', {
            error: err
        })
        console.log(err.stack);
    }
)

app.listen(config.express.port, () => {
    console.log('express is a go')
})

bot.on('ready', () => {
    console.log(`Discord ready as ${bot.user.username}#${bot.user.discriminator} (${bot.user.id})`)
})

bot.connect();