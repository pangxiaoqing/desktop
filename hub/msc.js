const os = require('os');
const fs = require('fs');
var appData = os.homedir() + "/.musicoin";
var logDir = appData + "/logs";
if (!fs.existsSync(appData)) fs.mkdirSync(appData);
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

/* static data is a set of template data that never changes */
const staticData = require('./static-data.js');
/* locale is a set of strings to be fed to app depending on language chosen */
const locale = require('./locale.js');
/* observable-factory is responsible to make properties update respective Polymer elements upon update of property */
const observable = require('./observable-factory.js');
/* console - convenience console emulation to output messages to stdout */
const console = require('./console.log.js');
/* observables init array together with init fn */
const initObservables = require('./observables-defs.js');
/* crypto for pwd ops */
const crypto = require('crypto');
var util = require('util');
var Promise = require('bluebird');

/* node localstorage to ensure existence of a kind of app storage without db. Can be substituted later with a kind of encrypted store */
const lStorage = require('node-localstorage');
var settings;
try {
  settings = require('../config/config.ext.js');
} catch (e) {
  settings = require('../config/config.std.js');
}
var AccountHistory = require('./account-history.js');

/* Run startup actions (currently, start geth and ipfs if they aren't already started) */
var Startup = require('./startup.js');
var startup = new Startup(console, appData);
if (settings.startup.chainInit) startup.initChain(settings.chainInit);
if (settings.startup.chain) startup.startChildProcess(settings.chain);
if (settings.startup.fileSharing) startup.startChildProcess(settings.fileSharing);

/* here I define backend restricted storage that is not accessible directly from interface */
var beRestricted = {
  currentKeystore:null,
  currentPrivateKeystore:null,
}

var cloneByValue = function(obj) {
  return JSON.parse(JSON.stringify(obj));
}


var localStorage = global.localStorage;
var sessionStorage = global.sessionStorage;
/* here we define main data hub object and include some static properties directly */
var mschub = {
  audioElement:null,
  toolSettings:{
  },
  financialData:{

  },
  worksEditor: {

  },
}


/* here we init observables defined in observables-defs.js */
var PropertyChangeSupport = require('./pcs.js');
var pcs = new PropertyChangeSupport(mschub);
initObservables(mschub);

// TODO: Probably pull these into initObservables


pcs.addObservable('currentAudioUrl', '');
pcs.addObservable('myWorks', []);
pcs.addObservable('pendingWorks', []);
pcs.addObservable('selectedWork', null);
pcs.addObservable('selectedArtist', null);
pcs.addObservable('transactionHistory', []);
pcs.addObservable('selectedPage', '');
pcs.addObservable('chainVersion', settings.chain.name);

// TODO: Added this temporarily. Removing lightwallet
pcs.addObservable('loggedIn', false);
pcs.addObservable('loginError', false);

// TODO: Seems like it would be better to have a more modular structure
mschub.audioHub = {};
var pcsAudio = new PropertyChangeSupport(mschub.audioHub);
pcsAudio.addObservable('playlist', []);
pcsAudio.addObservable('currentPlay', {});
pcsAudio.addObservable('playPendingPayment', {});
pcsAudio.addObservable('playbackPaymentPercentage', staticData.playback.playbackPaymentPercentage);

/* as it's not possible to define observables with initObservables having initial values depending on objects in this module scope we must define them separately.
TODO: make it possible. */
observable(mschub,'ui', settings.ui);
observable(mschub,'lightwallet', settings.lightwallet);
observable(mschub,'rpcComm', settings.rpcComm);
observable(mschub,'loginLock',true);
observable(mschub,'locale',locale[mschub.lang]);
observable(mschub,'ipfsReady',false);
observable(mschub,'serverReady',false);
observable(mschub,'userGuest',staticData.guestUser.entry);
observable(mschub,'userDetails',staticData.guestUser.entry);
observable(mschub,'listUsers',[staticData.guestUser.list]);
observable(mschub,'notifyAccCreateDialog',null);

var pcsFinData = new PropertyChangeSupport(mschub.financialData);
pcsFinData.addObservable('selectedAccount', null);
pcsFinData.addObservable('accounts', []);
pcsFinData.addObservable('userBalance', 0);
var MusicoinService = require("./musicoin-connector.js");

var Web3Connector = require('./web3-connector.js');
pcs.addObservable('syncStatus', {});

var web3Connector = new Web3Connector(settings.chain, startup.injectPathVariables(settings.chain.txDirectory), mschub, function(connected) {
  if (connected) {
    mschub.financialData.selectedAccount = web3Connector.getSelectedAccount();
    mschub.financialData.accounts = web3Connector.getAccounts();
    console.log("selectedAccount: " + web3Connector.getSelectedAccount())
    console.log(web3Connector.getAccounts());

    // TESTING
    if (settings.utilities.autoPlayNewLicenses) {
      console.log("Auto-playing new licenses");
      web3Connector.listenForNewLicense(function(licenseAddress) {
        console.log("Auto-play found new license: " + licenseAddress);
        Promise.resolve({})
          .then(function() {
            var licenseContract = web3Connector.getLicenseContractInstance(licenseAddress);
            var workContract = web3Connector.getWorkContractInstance(licenseContract.workAddress());
            var license = {
              contract_id: licenseAddress,
              song_name: workContract.title(),
              artist_name: workContract.artist(),
              image_url_https: workContract.imageUrl().replace("ipfs://", "https://ipfs.io/ipfs/")
            }
            return license;
          })
          .then(function(license) {
            console.log("Auto-play playing: " + JSON.stringify(license));
            mschub.audioHub.playlist.unshift(license);
          })
      })
    }
  }
});

var musicoinService = new MusicoinService(settings.musicoinService.host, web3Connector);
pcs.addObservable('catalogBrowseItems', []);
pcs.addObservable('browseCategories', []);

mschub.userPreferences = {};
var pcsUserPrefs = new PropertyChangeSupport(mschub.userPreferences);
pcsUserPrefs.addObservable('following', []);
pcsUserPrefs.addObservable('playlists', []);
pcsUserPrefs.addObservable('username', '');
pcsUserPrefs.addObservable('musicianMode', false);
pcsUserPrefs.addObservable('registrationStatus', {});
pcsUserPrefs.addObservable('playlistEdit', "", true);
pcsUserPrefs.addObservable('maxMusicoinPerPlay', 1);

// PreferenceManager handles swapping in/out of preferences when the selected account changes
var PreferenceManager = require("./preferences.js");
var preferenceManager = new PreferenceManager(mschub.userPreferences, musicoinService, appData + "/users/");
pcsFinData.attach().to('selectedAccount', function(oldAccount, newAccount) {
  preferenceManager.setCurrentAccount(newAccount)
    .catch(function(err) {
      console.log("Could not load preferences: " + err);
    })
});

var AccountHistoryManager = require("./account-history-manager.js");
var accountHistoryManager = new AccountHistoryManager(web3Connector);
mschub.accountHistoryStatus = accountHistoryManager.getStatus();
pcsFinData.attach().to('selectedAccount', function(oldAccount, newAccount) {
  accountHistoryManager.setCurrentAccount(newAccount)
    .catch(function(err) {
      console.log("Could not load account history: " + err);
    })
});

var MessageMonitor = require("../facade/message-monitor");
mschub.messageMonitor = new MessageMonitor();

pcs.addObservable('ipfsStatus', {});
var IPFSConnector = require("./ipfs-connector.js");
var ipfsConnector = new IPFSConnector(mschub);


var LocalMediaServer = require('./local-media-server.js');
var localMediaServer = new LocalMediaServer(web3Connector);

mschub.clientUtils = {
  convertToMusicoinUnits: function(wei) {
    return web3Connector.toMusicCoinUnits(wei);
  },
  getMediaUrlForLicense: function(licenseAddress) {
    return localMediaServer.getMediaUrlForLicense(licenseAddress);
  },
  resolveUrl: function(url) {
    return ipfsConnector.convertUrlToLocalhost(url);
  },
  getLogDir: function() {
    return logDir;
  }
}

var shuffle = function (a) {
  var j, x, i;
  for (i = a.length; i; i--) {
    j = Math.floor(Math.random() * i);
    x = a[i - 1];
    a[i - 1] = a[j];
    a[j] = x;
  }
}

/* here we define functions pool. It can be called from the interface with respective fngroup and fn provided to execute function on backend and grab result */
mschub.fnPool = function(fngroup, fn, elem, params) {
  var fns = {
    login:{
      loginToDefault: function(elem, params, fns) {
        mschub.loginError = null;
        web3Connector.storeCredentials(params.pwd)
          .then(function() {
            mschub.loggedIn = true;
            mschub.loginLock = false;
          })
          .catch(function(e) {
            mschub.loginError = "Login failed";
          });
      },
      createAccount: function() {
        web3Connector.createAccount(params.pwd)
          .then(function() {
            mschub.loggedIn = true;
            mschub.loginLock = false;
            mschub.loginError = null;
            mschub.financialData.selectedAccount = web3Connector.getSelectedAccount();
          })
          .catch(function(e) {
            mschub.loginError = e;
          })
      },
      selectAccount: function() {
        web3Connector.setSelectedAccount(params.account)
          .then(function(selected) {
            mschub.loginError = null;
            mschub.financialData.selectedAccount = web3Connector.getSelectedAccount();
          })
          .catch(function(e) {
            mschub.loginError = e;
            console.log(e);
        })
      }
    },
    audio:{
      playAll: function(elem, params, fns) {
        mschub.audioHub.playlist = params.items;
        fns.audio.playNext(elem, {}, fns);
      },
      shuffleAll: function(elem, params, fns) {
        var items = params.items.slice();
        shuffle(items);
        mschub.audioHub.playlist = items;
        fns.audio.playNext(elem, {}, fns);
      },
      playNext: function(elem, params, fns) {
        var next = mschub.audioHub.playlist.shift();
        var threshold = web3Connector.toIndivisibleUnits(mschub.userPreferences.maxMusicoinPerPlay);
        while (next && next.wei_per_play > threshold) {
          console.log("Skipping play that is above the user's defined wei_per_play threshold: " + next.wei_per_play + " > " + threshold);
          next = mschub.audioHub.playlist.shift();
        }
        mschub.audioHub.currentPlay = next || {};
        mschub.audioHub.playPendingPayment = mschub.audioHub.currentPlay;
      },
      reportPlaybackPercentage: function(elem, params, fns) {
        if (params.percentage > mschub.audioHub.playbackPaymentPercentage) {
          var pending = mschub.audioHub.playPendingPayment;
          mschub.audioHub.playPendingPayment = null;
          if (pending) {
            fns.finops.payForPlay(elem, {
              address: pending.contract_id,
              weiAmount: pending.wei_per_play
            }, fns);
          }
        }
      }
    },
    catalog: {
      loadBrowsePage: function(elem, params, fns) {
        mschub.catalogBrowseItems = [];
        musicoinService.loadBrowsePage(params.page, params.keyword, function(result) {
          mschub.catalogBrowseItems = result;
        });
        return {result: "pending"};
      },
      loadBrowseCategories: function(elem, params, fns) {
        musicoinService.loadBrowseCategories(function(result) {
          mschub.browseCategories = result;
        });
        return {result: "pending"};
      },
      loadMyWorks: function(elem, params, fns) {
        musicoinService.loadMyWorks(web3Connector.getSelectedAccount())
          .then(function(result) {
            result.forEach(function (work) {
              if (mschub.pendingWorks[work.contract_address])
                delete mschub.pendingWorks[work.contract_address];
            });
            for (var pendingId in mschub.pendingWorks) {
              result.push(mschub.pendingWorks[pendingId]);
            }
            mschub.myWorks = result;
          });
        return {result: "pending"};
      },
      loadArtist: function(elem, params, fns) {
        musicoinService.loadArtist(params.artist_address)
          .then(function(result) {
            mschub.selectedArtist = result;
          });
        return {result: "pending"};
      },
      loadArtists: function(elem, params, fns) {
        return mschub.messageMonitor.notifyOnCompletion(
          musicoinService.loadArtists(params.artist_addresses)
        );
      },
      loadLicenses: function(elem, params, fns) {
        var tx = mschub.messageMonitor.create();
        musicoinService.loadLicenseDetails(params.licenses)
          .then(function(items) {
            mschub.messageMonitor.success(tx, items);
          });
        return tx;
      },
      loadLicense: function(elem, params, fns) {
       return mschub.messageMonitor.notifyOnCompletion(web3Connector.loadLicenseDetails(params.license));
      }
    },
    mining: {
      startMining: function() {
        web3Connector.startMining();
      },
      stopMining: function() {
        web3Connector.stopMining();
      }
    },
    publish: {
      releaseWork: function(elem, params, fns) {
        var work = params.work;
        var workReleaseRequest = {
          type: work.type,
          title: work.title,
          artist: work.artist,
          imageUrl: "",
          metadataUrl: ""
        };

        var tx = mschub.messageMonitor.create();
        mschub.pendingWorks[tx] = work;
        ipfsConnector.add(work.imgFile)
          .then(function (hash) {
            workReleaseRequest.imageUrl = "ipfs://" + hash;
            return ipfsConnector.addString(JSON.stringify(work.metadata));
          })
          .then(function (hash) {
            workReleaseRequest.metadataUrl = "ipfs://" + hash;
            return web3Connector.releaseWork(workReleaseRequest);
          })
          .then(function (contractAddress) {
            delete mschub.pendingWorks[tx];
            mschub.pendingWorks[contractAddress] = work;
            mschub.messageMonitor.success(tx, contractAddress);
            return contractAddress;
          })
          .catch(function(err) {
            if (mschub.pendingWorks[tx]) delete mschub.pendingWorks[tx];
            mschub.messageMonitor.error(tx, err);
          });
        return tx;
      },
      releaseLicense: function(elem, params, fns) {
        var license = params.license;
        var licenseReleaseRequest = {
          workAddress: license.workAddress,
          coinsPerPlay: license.coinsPerPlay,
          resourceUrl: "",
          metadataUrl: "",
          royalties: license.royalties.map(function (r) {return r.address}),
          royaltyAmounts: license.royalties.map(function (r) {return r.amount}),
          contributors: license.contributors.map(function (r) {return r.address}),
          contributorShares: license.contributors.map(function (r) {return r.shares}),
        };

        var tx = mschub.messageMonitor.create();
        localMediaServer.encrypt(license.audioFile, license.artist, license.title)
          .then(function(tmpFile) {
            return ipfsConnector.add(tmpFile)
              .then(function(hash) {
                fs.unlink(tmpFile, function(err) {
                  if (err) console.log("Could not delete temp file: " + err);
                });
                return hash;
              });
          })
          .then(function (hash) {
            licenseReleaseRequest.resourceUrl = "eipfs://" + hash;
            return web3Connector.releaseLicense(licenseReleaseRequest);
          })
          .then(function (contractAddress) {
            mschub.messageMonitor.success(tx, contractAddress);
            return contractAddress;
          })
          .catch(function(err) {
            mschub.messageMonitor.error(tx, err);
          });

        return tx;
      }
    },
    finops:{
      sendTip:function(elem, params, fns){
        var msgId = mschub.messageMonitor.create();
        var wei = params.weiAmount ? params.weiAmount : web3Connector.toIndivisibleUnits(params.musicoinAmount);
        web3Connector.tip({amount: wei, to: params.address})
        .then(function(receipt) {
          mschub.messageMonitor.success(msgId, {});
          console.log(JSON.stringify(receipt));
        })
        .catch(function(err) {
          mschub.messageMonitor.error(msgId, err);
        });
        return msgId;
      },
      send:function(elem, params, fns){
        var msgId = mschub.messageMonitor.create();
        var wei = params.weiAmount ? params.weiAmount : web3Connector.toIndivisibleUnits(params.musicoinAmount);
        web3Connector.send({amount: wei, to: params.address})
          .then(function(receipt) {
            mschub.messageMonitor.success(msgId, {});
            console.log(JSON.stringify(receipt));
          })
          .catch(function(err) {
            mschub.messageMonitor.error(msgId, err);
          });
        return msgId;
      },
      payForPlay: function(elem, params, fns) {
        var msgId = mschub.messageMonitor.create();
        var wei = params.weiAmount ? params.weiAmount : web3Connector.toIndivisibleUnits(params.musicoinAmount);
        web3Connector.ppp({to: params.address, amount: wei})
          .then(function(receipt) {
            mschub.messageMonitor.success(msgId, {});
            console.log(JSON.stringify(receipt));
          })
          .catch(function(err) {
            mschub.messageMonitor.error(msgId, err);
            fns.audio.playNext(); // force the next track, they can't pay for this one.
          });
        return msgId;
      },
      loadHistory: function(elem, params, fns) {
        accountHistoryManager.loadTransactions();
        return {result: "pending"};
      },
      updateUserBalance: function(elem, params, fns) {
        web3Connector.getUserBalanceInMusicoin()
          .then(function(result) {
            mschub.financialData.userBalance = result;
          })
          .catch(function(err) {
            console.log(err);
          });
      }
    },
    profile: {
      setUsername: function(elem, params, fns) {
        mschub.userPreferences.username = params.username;
        preferenceManager.savePreferences();
      },
      setMusicianMode: function(elem, params, fns) {
        mschub.userPreferences.musicianMode = params.enabled;
        preferenceManager.savePreferences();
      },
      follow: function(elem, params, fns) {
        preferenceManager.follow(params.artist_address);
      },
      unfollow: function(elem, params, fns) {
        preferenceManager.unfollow(params.artist_address);
      },
      addPlaylist: function(elem, params, fns) {
        preferenceManager.addPlaylist(params.playlistName);
      },
      removePlaylist: function(elem, params, fns) {
        preferenceManager.removePlaylist(params.playlistName);
      },
      addToPlaylist: function(elem, params, fns) {
        return mschub.messageMonitor.notifyOnCompletion(
          preferenceManager.addToPlaylist(params.playlistName, params.licenseId, params.suppressDuplicates)
            .bind(this)
            .then(function(){
              this.userPreferences.playlistEdit = params.playlistName;
            })
        );
      },
      removeFromPlaylist: function(elem, params, fns) {
        return mschub.messageMonitor.notifyOnCompletion(
          preferenceManager.removeFromPlaylist(params.playlistName,params.licenseId)
            .bind(this)
            .then(function(){
              this.userPreferences.playlistEdit = params.playlistName;
            })
        );
      },
      moveItemInPlaylist: function(elem, params, fns) {
        return mschub.messageMonitor.notifyOnCompletion(
          preferenceManager.moveItemInPlaylist(params.playlistName,params.from,params.to)
            .bind(this)
            .then(function(){
              this.userPreferences.playlistEdit = params.playlistName;
            })
        );
      },
    }
  };
  /* Here we either call a function called by fngroup/fn (and return its return) providing it with element object, passed parameters, fns var (to make sure functions can communicate and call themselves if needed) and setting 'this' to module exports (in this case mschub) or return object with one member - error to be managed by window. */
  return (fns[fngroup] && fns[fngroup][fn])?(mschub.loginLock && ~['chain', 'audio'].indexOf(fngroup))?{error:'No user logged in'}:fns[fngroup][fn].call(this,elem, params, fns):{error:'Invalid function called'};
}

mschub.fnPool('catalog','loadBrowseCategories');

// This is for testing, mainly.  It allows you to set up an instance that will just loop and play new releases
console.log("New release auto-loop: Initializing: " + settings.utilities.loopAllNewReleases);
if (settings.utilities.loopAllNewReleases) {
  var isEmptyObject = function (obj) {
    for (var name in obj) {
      return false;
    }
    return true;
  };
  var refreshNewReleases = function () {
    if (!mschub.loggedIn) return;

    console.log("New release auto-loop: updating new releases");
    musicoinService.loadBrowsePage("new-releases", "", function (groups) {
      console.log("New release auto-loop: Got new releases");
      if (mschub.audioHub.playlist.length < 3 && groups && groups.length > 0 && groups[0].result) {
        console.log("New release auto-loop: Appending new release items to the playlist");
        var items = groups[0].result;
        mschub.audioHub.playlist = mschub.audioHub.playlist.concat(items);
        if (isEmptyObject(mschub.audioHub.playPendingPayment)) {
          console.log("New release auto-loop: kickstarting audio");
          mschub.fnPool('audio', 'playNext');
        }
      }
      else {
        console.log("New release auto-loop: Not updating playlist, enough items are there");
      }
    });
  }

  console.log("New release auto-loop: ON");
  refreshNewReleases();
  window.setInterval(refreshNewReleases, 30 * 1000);
}

mschub.audio = require('../facade/audio.js')(mschub);
mschub.payments = require('../facade/payments.js')(mschub);
mschub.catalog = require('../facade/catalog.js')(mschub);
mschub.login = require('../facade/login.js')(mschub);
mschub.profile = require('../facade/profile.js')(mschub);

pcs.addObservable('version', 'unknown');
fs.exists("version.txt", function(exists) {
  if (exists) {
    fs.readFile("version.txt", function(err, result) {
      if (err) {
        console.log("Checking version... failed: " + err);
        return;
      }
      console.log("Version " + result);
      mschub.version = result;
    })
  }
  else {
    console.log("Checking version failed... version file does not exist");
  }
});

/* Here we export the hub's reference to be accessible for the interface */
exports.mscdata = mschub

if (!settings.lightwallet) {
  mschub.fnPool('finops', 'updateUserBalance');
  setInterval(()=>{
    mschub.fnPool('finops', 'updateUserBalance')}, 1000);
  }

if (mschub.rpcComm) {
  /* express like (better) net server */
  const koa = require('koa')
  const route = require('koa-route')
  const websockify = require('koa-websocket');
  const session = require('koa-session');
  const comm = websockify(koa());
  var netSrvSession = session(comm);
  var wssend = null;
  /* websockets and other comm */
  comm.ws.use(route.all('/', function* (next) {
    this.websocket.on('message', function(message) {
      try {
        message = JSON.parse(message);
      } catch (e) {

      } finally {

      }
      console.log(message);
      console.log('MSG');
    });
    console.log(this.websocket.on);
    this.websocket.on('connect', function() {
      console.log('OPEN');
    });
    wssend = this;
    this.websocket.send(JSON.stringify({result:{relmethod:'greetings', data:'Hello Client!', id:null}}));

    yield next;
  }));

  comm.ws.use(route.all('/auth', function* (next) {
    this.websocket.on('message', function(message) {
      try {
        message = JSON.parse(message);
      } catch (e) {

      } finally {

      }
      console.log(message);
      console.log('MSG');
    });
    console.log(this.websocket.on);
    this.websocket.on('connect', function() {
      console.log('OPEN');
    });
    wssend = this;
    this.websocket.send(JSON.stringify({result:{relmethod:'greetings', data:'Hello Client!', id:null}}));

    yield next;
  }));
  comm.ws.use(route.all('/public', function* (next) {
    this.websocket.on('message', function(message) {
      try {
        message = JSON.parse(message);
      } catch (e) {

      } finally {

      }
      console.log(message);
      console.log('MSG');
    });
    console.log(this.websocket.on);
    this.websocket.on('connect', function() {
      console.log('OPEN');
    });
    wssend = this;
    this.websocket.send(JSON.stringify({result:{relmethod:'greetings', data:'Hello Client!', id:null}}));

    yield next;
  }));

  //setTimeout(()=>{console.log(comm.ws.server.clients);},3000);
  comm.listen(22222);
}
