const config = require('./config.json');
require('express-async-errors'); // express, pls
const express = require('express');
const querystring = require('querystring');
const crypto = require('crypto');
const superagent = require('superagent');
const session = require('express-session');
const Redite = require('redite');
const eris = require('eris');
const games = require('./games.json');
const tags = require('./data/tags.json');
const bodyParser = require('body-parser');
const httpErrors = {
    codes: require('./data/errorcodes.json'),
    messages: require('./data/errormsgs.json')
}
const API_ROOT = 'https://discordapp.com/api/v6'

const redisDataModel = {
    permissions: [],
    runs: []
}

var redis; // DONT TOUCH THIS
const app = express();
const bot = new eris(`Bot ${config.bot.token}`, {
    restMode: true
});

app.set('view engine', 'ejs') // use ejs

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('static')) // set up static memes

const renderHTTPError = (req, res, status) => {
    let strs = status.toString()
    res.status(status).render('htmlerror', {
        errno: strs,
        meaning: httpErrors.codes[strs],
        errmsg: httpErrors.messages[strs]
    })
    res.end();
}

const randomID = length => {
    return crypto.randomBytes(length).toString('hex');
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
    let state = randomID(20);
    req.session.state = state;
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
    if (req.query.state !== req.session.state) return renderHTTPError(req, res, 400); // die if states don't match
    req.session.state = null;
    try {
        let ret = await superagent.post(`${API_ROOT}/oauth2/token`).send(data).set(headers).auth(config.oauth.id, config.oauth.secret);
        let token = ret.body.token_type + ' ' + ret.body.access_token;
        req.session.tokenData = ret.body;
        req.session.token = token;
        let userRes = await superagent.get(`${API_ROOT}/users/@me`).set({'Authorization': token});
        let user = userRes.body;
        req.session.user = user;
        if (!await redis[user.id]()) {
            await redis[user.id].set(redisDataModel)
        } else {
            // it is set, go check
            let doSet = false;
            let data = await redis[user.id]();
            for (let i of Object.keys(redisDataModel)) {
                if (!data[i]) {
                    data[i] = redisDataModel[i]; // performance coding
                    doSet = true;
                }
            }
            if (doSet) await redis[user.id].set(data);
        }
        res.redirect('/dashboard')
    } catch(e) {
        res.render('error', {
            msg: 'Error while retrieving user token.',
            error: e.stack
        })
    }
})

app.get('/dashboard', async (req, res) => {
    if (!req.session.user) res.redirect('/auth');
    try {
        let tempuser = await superagent.get(`${API_ROOT}/users/@me`).set({'Authorization': req.session.token});
        req.session.user = tempuser.body;
    } catch(e) {
        res.redirect('/auth')
    }
    let meme = await redis[req.session.user.id]();
    console.log(meme);
    let perms = meme.permissions || [];
    let ejstags = perms.map(a => tags[a])
    res.render('dashboard', {
        user: req.session.user,
        tags: ejstags
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
        return renderHTTPError(req, res, 403)
    }
    res.render('submit', {
        user: req.session.user,
        games,
        success: req.query.success || false
    })
})

app.post('/api/submit', async (req, res) => {
    if (!req.session.user) return renderHTTPError(req, res, 401);
    try {
        let tempuser = await superagent.get(`${API_ROOT}/users/@me`).set({'Authorization': req.session.token});
        req.session.user = tempuser.body;
    } catch(e) {
        return renderHTTPError(req, res, 401) // die if token badde:tm:
    }
    console.log(req.body);
    if (!req.body.game || !req.body.time || !req.body.video) return res.status(400).send({error: 'missing game, time or video'})
    if (!/(?:https?:\/\/)(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9=]+)/gm.test(req.body.video)) {
        return res.status(400).send({error: 'bad video (must be on youtube)'})
    }
    if (!/(?:(\d{2,}):)?(\d{2,}):(\d{2,})(?:\.(\d{1,}))?/.test(req.body.time)) {
        return res.status(400).send({error: 'bad time (must be hh:mm:ss.ms)'})
    }
    let game = games[req.body.game]
    if (!game) return res.status(400).send({error: 'invalid game'})
    await bot.createMessage(config.bot.runChannel, `<@&${config.bot.runRole}> new run by <@${req.session.user.id}> (${req.session.user.username}#${req.session.user.discriminator})\nGame: ${game.name} (${game.short})\nTime: ${req.query.time}`)
    let meme = await redis[req.session.user.id]();
    meme.runs.push({
        game,
        video: req.body.video,
        time: req.body.time
    })
    await redis[req.session.user.id].set(meme);
    res.redirect('/submit?success=true');
})

app.get('/users/:userId', async (req, res) => {
    if (!req.params.userId) {
        return renderHTTPError(req, res, 400)
    }
    let user;
    try {
        user = await bot.getRESTUser(req.params.userId)
    } catch(e) {
        return renderHTTPError(req, res, 400)
    }
    if (!user) return renderHTTPError(req, res, 400)
    let meme = await redis[user.id]();
    if (!meme) return renderHTTPError(req, res, 400)
    let perms = meme.permissions || [];
    let ejstags = perms.map(a => tags[a]);
    res.render('userPage', {
        user,
        tags: ejstags,
        runs: meme.runs
    })
})

app.get('/error', async (req, res) => {
    throw new TypeError('testing');
})

app.get('/error/http', async (req, res) => {
    return renderHTTPError(req, res, parseInt(req.query.error) || 500)
})

app.get('*', async (req, res) => {
    return renderHTTPError(req, res, 404);
})

app.use(
    (err, req, res, next) => {
        res.status(500).render('error', {
            error: err
        })
        console.log(err.stack);
    }
)

try {
    redis = new Redite(config.redis.url);
    console.log('Redis is a go');
} catch(e) {
    console.error('Redis init failed. '+e);
    process.exit(1);
}

bot.on('ready', () => {
    console.log(`Discord ready as ${bot.user.username}#${bot.user.discriminator} (${bot.user.id})`)
})

app.listen(config.express.port, () => {
    console.log('express is a go')
})

bot.connect();